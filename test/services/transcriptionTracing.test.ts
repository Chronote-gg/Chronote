/** @jest-environment node */
import {
  flushTurn,
  validResponse,
  waitFor,
  withTracingFixture,
  type AttachmentFailure,
  type TracingFixture,
} from "../fixtures/transcriptionTracing";

jest.setTimeout(15_000);

async function expectOwned(f: TracingFixture) {
  await flushTurn();
  expect(f.generationStarted).toHaveBeenCalledTimes(1);
  expect(f.generationEnded).not.toHaveBeenCalled();
  expect(f.wavDeleted).not.toHaveBeenCalled();
  expect(f.pcmDeleted).not.toHaveBeenCalled();
}

function expectReleased(f: TracingFixture) {
  expect(f.generationEnded).toHaveBeenCalledTimes(1);
  expect(f.wavDeleted).toHaveBeenCalledTimes(1);
  expect(f.pcmDeleted).toHaveBeenCalledTimes(1);
  expect(f.events.indexOf("generation-ended")).toBeLessThan(
    f.events.indexOf("wav-deleted"),
  );
}

function expectPreservedTrace(f: TracingFixture, vote: boolean) {
  const requests = vote ? 2 : 1;
  const candidate = vote ? "no_prompt" : "prompt";
  expect(f.create).toHaveBeenCalledTimes(requests);
  expect(f.create.mock.calls[0]).toEqual([
    expect.objectContaining({
      model: "gpt-4o-transcribe",
      language: "en",
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      prompt: "Project Orion delivery terminology.",
    }),
    { signal: f.signal, maxRetries: 0 },
  ]);
  if (vote) {
    expect(f.create.mock.calls[1][0]).not.toHaveProperty("prompt");
  }
  expect(f.state).toMatchObject({
    input: {
      language: "en",
      prompt: "Project Orion delivery terminology.",
      audio: expect.anything(),
    },
    model: "gpt-4o-transcribe",
    modelParameters: {
      temperature: 0,
      response_format: "json",
      include: "logprobs",
    },
    output: validResponse.text,
    usageDetails: {
      input: 23 * requests,
      output: 11 * requests,
      total: 34 * requests,
    },
    metadata: {
      audioBytes: 192_000,
      audioSeconds: 1,
      audioAttachmentBytes: 12,
      audioAttachmentContentType: "audio/mpeg",
      promptLength: "Project Orion delivery terminology.".length,
      transcriptionCostAccountingStatus: "priced",
      transcriptionRequestCount: requests,
      transcriptionPricedRequestCount: requests,
      transcriptionUnpricedRequestCount: 0,
      transcriptionCandidate: candidate,
      transcriptionVoteSelected: candidate,
      transcriptionVoteAttempted: vote,
    },
  });
  expect(f.inputClosed).toHaveBeenCalledTimes(requests);
  expect(f.mp3Deleted).toHaveBeenCalledTimes(1);
  expect(f.events.indexOf("mp3-deleted")).toBeLessThan(
    f.events.indexOf("generation-ended"),
  );
}

test.each([
  { attachmentFirst: false, vote: false },
  { attachmentFirst: true, vote: false },
  { attachmentFirst: false, vote: true },
  { attachmentFirst: true, vote: true },
])(
  "overlaps ASR and preserves trace fields (attachmentFirst=$attachmentFirst, vote=$vote)",
  async ({ attachmentFirst, vote }) => {
    await withTracingFixture({}, async (f) => {
      const result = f.transcribe();
      await waitFor(f.executionEntered, "policy execution entered");
      await waitFor(f.attachmentEntered, "attachment entered");
      await waitFor(
        f.providerEntered,
        "provider entered while attachment held",
      );
      if (attachmentFirst) {
        f.attachment.resolve();
        await waitFor(f.attachmentRecorded, "attachment input recorded");
        await expectOwned(f);
      }
      f.provider.resolve(
        vote
          ? {
              ...validResponse,
              text: "Uncertain wording.",
              logprobs: [{ token: "Uncertain", logprob: -3, bytes: [] }],
            }
          : validResponse,
      );
      await waitFor(f.usageRecorded, "selection and usage recorded");
      if (!attachmentFirst) {
        await expectOwned(f);
        expect(f.mp3Deleted).not.toHaveBeenCalled();
        f.attachment.resolve();
      }
      await expect(result).resolves.toEqual({
        status: "succeeded",
        text: validResponse.text,
        admission: { kind: "not_enforced", reason: "off" },
      });
      expectReleased(f);
      expectPreservedTrace(f, vote);
      const earlier = attachmentFirst
        ? "attachment-recorded"
        : "usage-recorded";
      const later = attachmentFirst ? "usage-recorded" : "attachment-recorded";
      expect(f.events.indexOf(earlier)).toBeLessThan(f.events.indexOf(later));
    });
  },
);

test("late abort after ASR accounting prevents successful snippet publication", async () => {
  await withTracingFixture({}, async (f) => {
    const publish = jest.fn();
    const result = f.transcribe().then((value) => {
      if (value.status === "succeeded") publish(value.text);
      return value;
    });
    await waitFor(f.providerEntered, "provider entered before late abort");
    f.provider.resolve(validResponse);
    await waitFor(f.usageRecorded, "ASR selection completed before late abort");
    const stopped = jest.fn();
    const drain = f.stop().then(stopped);
    expect(f.signal.aborted).toBe(true);
    await expectOwned(f);
    expect(stopped).not.toHaveBeenCalled();
    f.attachment.resolve();
    await expect(result).resolves.toMatchObject({ status: "failed" });
    await drain;
    expect(publish).not.toHaveBeenCalled();
    expect(f.state.input).not.toHaveProperty("audio");
    expect(f.state.usageDetails).toEqual({ input: 23, output: 11, total: 34 });
    expect(f.mp3Deleted).toHaveBeenCalledTimes(1);
    expectReleased(f);
  });
});

test("abort during started attachment retains files and ownership until encoding settles", async () => {
  await withTracingFixture({}, async (f) => {
    const result = f.transcribe();
    await waitFor(f.attachmentEntered, "running attachment");
    await waitFor(f.providerEntered, "provider entered before running abort");
    const stopped = jest.fn();
    const drain = f.stop().then(stopped);
    f.provider.resolve(validResponse);
    await waitFor(f.providerSettled, "provider settled after abort");
    await expectOwned(f);
    expect(stopped).not.toHaveBeenCalled();
    expect(f.mp3Deleted).not.toHaveBeenCalled();
    f.attachment.resolve();
    await expect(result).resolves.toMatchObject({ status: "failed" });
    await drain;
    expect(f.state.input).not.toHaveProperty("audio");
    expect(f.state).not.toHaveProperty("output");
    expect(f.events.indexOf("encoder-settled")).toBeLessThan(
      f.events.indexOf("mp3-deleted"),
    );
    expect(f.events.indexOf("mp3-deleted")).toBeLessThan(
      f.events.indexOf("generation-ended"),
    );
    expectReleased(f);
  });
});

test("queued attachment abort skips encoding and settles its owned queue work", async () => {
  await withTracingFixture({ queued: true }, async (f) => {
    const result = f.transcribe();
    await waitFor(f.attachmentQueued, "attachment queued");
    const stopped = jest.fn();
    const drain = f.stop().then(stopped);
    f.provider.resolve(validResponse);
    await expectOwned(f);
    expect(stopped).not.toHaveBeenCalled();
    expect(f.helperStarted).not.toHaveBeenCalled();
    f.releaseQueue();
    await expect(result).resolves.toMatchObject({ status: "failed" });
    await drain;
    expect(f.helperStarted).not.toHaveBeenCalled();
    expect(f.mp3Deleted).not.toHaveBeenCalled();
    expect(f.state.input).not.toHaveProperty("audio");
    expectReleased(f);
  });
});

const attachmentFailures: AttachmentFailure[] = ["helper", "update", "warning"];
describe.each(attachmentFailures)(
  "%s attachment failure",
  (attachmentFailure) => {
    test.each(["success", "provider failure"])(
      "preserves %s without an unhandled rejection",
      async (outcome) => {
        await withTracingFixture({ attachmentFailure }, async (f) => {
          const providerError = new Error("original provider failure");
          const result = f.transcribe();
          await waitFor(
            f.providerEntered,
            "provider entered with attachment fault",
          );
          if (outcome === "success") {
            f.provider.resolve(validResponse);
            await waitFor(f.usageRecorded, "successful ASR accounting");
          } else {
            f.provider.reject(providerError);
            await waitFor(f.providerSettled, "rejected provider settled");
          }
          await expectOwned(f);
          f.attachment.resolve();
          const expected =
            outcome === "success"
              ? {
                  status: "succeeded",
                  text: validResponse.text,
                  admission: { kind: "not_enforced", reason: "off" },
                }
              : { status: "failed", reason: "transcription_error" };
          await expect(result).resolves.toEqual(expected);
          if (outcome === "success") {
            expect(f.policyRejected).not.toHaveBeenCalled();
          } else {
            expect(f.policyRejected).toHaveBeenCalledTimes(1);
            expect(f.policyRejected).toHaveBeenCalledWith(providerError);
            expect(f.policyRejected.mock.calls[0][0]).toBe(providerError);
          }
          expect(f.warning).toHaveBeenCalledWith(
            "Failed to attach transcription audio to Langfuse.",
            expect.any(Error),
          );
          expectReleased(f);
        });
      },
    );
  },
);
