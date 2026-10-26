/** @jest-environment node */
import type { ClientOptions } from "openai";
import { setTimeout as wait } from "node:timers/promises";
import {
  buildTracingFixture,
  deferred,
  validResponse,
  waitFor,
  withTracingFixture,
} from "../fixtures/transcriptionTracing";

jest.setTimeout(30_000);

const uncertainResponse = {
  ...validResponse,
  text: "Uncertain wording.",
  logprobs: [{ token: "Uncertain", logprob: -3, bytes: [] }],
};

function providerTransport(
  respond: (prompt: boolean, attempt: number) => Promise<Response>,
) {
  const calls: boolean[] = [];
  const fetch: NonNullable<ClientOptions["fetch"]> = async (_url, init) => {
    const body = await new Response(init?.body).text();
    const prompt = body.includes('name="prompt"');
    calls.push(prompt);
    return respond(prompt, calls.length);
  };
  return { fetch, calls };
}

const unavailable = () =>
  Response.json(
    { error: { message: "synthetic unavailable" } },
    { status: 503, headers: { "retry-after-ms": "0" } },
  );

test("vote retry retains prompted success and prepares prompt and attachment once", async () => {
  let voteAttempts = 0;
  const provider = providerTransport(async (prompt) => {
    if (prompt) return Response.json(uncertainResponse);
    return ++voteAttempts === 1 ? unavailable() : Response.json(validResponse);
  });
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
      text: validResponse.text,
    });
    expect(provider.calls).toEqual([true, false, false]);
    expect(f.preparePrompt).toHaveBeenCalledTimes(1);
    expect(f.helperStarted).toHaveBeenCalledTimes(1);
    expect(f.inputClosed).toHaveBeenCalledTimes(3);
    expect(f.state.metadata).toMatchObject({
      transcriptionLogicalCandidateCount: 2,
      transcriptionSdkInvocationCount: 3,
      transcriptionHttpDispatchAttemptCount: 3,
      transcriptionRetryCount: 1,
      transcriptionKnownUsageAttemptCount: 2,
      transcriptionUnknownUsageAttemptCount: 1,
      transcriptionAttemptUsageCoverage: "partial",
      transcriptionCostAccountingStatus: "partial",
      transcriptionRequestCount: 2,
    });
    expect(f.state.usageDetails).toEqual({ input: 46, output: 22, total: 68 });
  });
});

test.each([400, 503])(
  "prompt usage survives terminal or exhausted vote HTTP %i",
  async (status) => {
    const provider = providerTransport(async (prompt) =>
      prompt
        ? Response.json(uncertainResponse)
        : Response.json(
            { error: { message: "synthetic vote failure" } },
            { status, headers: { "retry-after-ms": "0" } },
          ),
    );
    await withTracingFixture({ transport: provider.fetch }, async (f) => {
      f.attachment.resolve();
      await expect(f.transcribe()).resolves.toMatchObject({ status: "failed" });
      expect(provider.calls.filter(Boolean)).toHaveLength(1);
      expect(provider.calls.filter((prompt) => !prompt)).toHaveLength(
        status === 503 ? 4 : 1,
      );
      expect(f.preparePrompt).toHaveBeenCalledTimes(1);
      expect(f.state.usageDetails).toEqual({
        input: 23,
        output: 11,
        total: 34,
      });
      expect(f.state.metadata).toMatchObject({
        transcriptionCostAccountingStatus: "partial",
        transcriptionRequestCount: 1,
        transcriptionKnownUsageAttemptCount: 1,
      });
    });
  },
);

test("both candidates may each use four attempts but never a fifth", async () => {
  const attempts = { prompt: 0, vote: 0 };
  const provider = providerTransport(async (prompt) => {
    const key = prompt ? "prompt" : "vote";
    attempts[key] += 1;
    return attempts[key] < 4
      ? unavailable()
      : Response.json(prompt ? uncertainResponse : validResponse);
  });
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(attempts).toEqual({ prompt: 4, vote: 4 });
    expect(f.state.metadata).toMatchObject({
      transcriptionHttpDispatchAttemptCount: 8,
      transcriptionRetryCount: 6,
      transcriptionKnownUsageAttemptCount: 2,
      transcriptionUnknownUsageAttemptCount: 6,
    });
  });
});

test("accounting observation failure cannot replace a successful ASR result", async () => {
  const provider = providerTransport(async () => Response.json(validResponse));
  await withTracingFixture(
    { transport: provider.fetch, accountingFailure: true },
    async (f) => {
      f.attachment.resolve();
      await expect(f.transcribe()).resolves.toMatchObject({
        status: "succeeded",
        text: validResponse.text,
      });
      expect(provider.calls).toHaveLength(1);
    },
  );
});

test("new diagnostics exclude provider body, header, path and identifier sentinels", async () => {
  const secret = "PRIVATE_ASR_SENTINEL";
  const provider = providerTransport(async () =>
    Response.json(
      { error: { message: secret, code: secret, request_id: secret } },
      { status: 400, headers: { "x-private-header": secret } },
    ),
  );
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({ status: "failed" });
    expect(JSON.stringify(f.state.metadata)).not.toContain(secret);
    expect(f.state.metadata).toMatchObject({
      transcriptionHttpDispatchAttemptCount: 1,
      transcriptionUnknownUsageAttemptCount: 1,
      transcriptionAttemptUsageCoverage: "unknown",
    });
  });
});

test("real bulkhead retires an aborted queued item and starts the next while another remains active", async () => {
  const held = [deferred<void>(), deferred<void>()];
  const started = [deferred<void>(), deferred<void>(), deferred<void>()];
  const provider = providerTransport(async (_prompt, attempt) => {
    started[attempt - 1]?.resolve();
    await held[attempt - 1]?.promise;
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  const aborted = new AbortController();
  try {
    f.attachment.resolve();
    const first = f.transcribe();
    const second = f.transcribe();
    await started[0].promise;
    await started[1].promise;
    const third = f.transcribe({ signal: aborted.signal });
    const fourth = f.transcribe();
    await f.waitForQueuedJobs(2);
    aborted.abort();
    held[0].resolve();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    await expect(third).resolves.toMatchObject({ status: "failed" });
    await waitFor(
      started[2].promise,
      "eligible job after aborted queue item",
      3_000,
    );
    expect(provider.calls).toHaveLength(3);
    await expect(fourth).resolves.toMatchObject({ status: "succeeded" });
    held[1].resolve();
    await expect(second).resolves.toMatchObject({ status: "succeeded" });
  } finally {
    held.forEach((work) => work.resolve());
    await f.dispose();
  }
});

test("real policy keeps the concurrency slot until attachment work drains", async () => {
  const entered = [deferred<void>(), deferred<void>(), deferred<void>()];
  const provider = providerTransport(async (_prompt, attempt) => {
    entered[attempt - 1]?.resolve();
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  try {
    const first = f.transcribe();
    const second = f.transcribe();
    const third = f.transcribe();
    await entered[0].promise;
    await entered[1].promise;
    await wait(1_000);
    expect(provider.calls).toHaveLength(2);
    f.attachment.resolve();
    await Promise.all([first, second, third]);
    expect(provider.calls).toHaveLength(3);
  } finally {
    await f.dispose();
  }
});

test("real breaker counts five exhausted logical ASR failures, then rejects before dispatch", async () => {
  const provider = providerTransport(async () => unavailable());
  await withTracingFixture(
    { realPolicies: true, transport: provider.fetch },
    async (f) => {
      f.attachment.resolve();
      for (let logical = 0; logical < 6; logical += 1) {
        await expect(f.transcribe()).resolves.toMatchObject({
          status: "failed",
        });
      }
      expect(provider.calls).toHaveLength(20);
      expect(f.preparePrompt).toHaveBeenCalledTimes(5);
      expect(f.helperStarted).toHaveBeenCalledTimes(5);
    },
  );
});

test("real breaker ignores terminal provider failures and unrelated SDK-shaped prompt errors", async () => {
  const provider = providerTransport(async () =>
    Response.json({ error: { message: "terminal" } }, { status: 400 }),
  );
  await withTracingFixture(
    { realPolicies: true, transport: provider.fetch },
    async (f) => {
      f.attachment.resolve();
      const { default: OpenAI } = await import("openai");
      const unrelated = new OpenAI.APIConnectionError({
        message: "prompt failure",
      });
      const { isTransientTranscriptionFailure } =
        await import("../../src/services/transcriptionRequest");
      expect(isTransientTranscriptionFailure(unrelated)).toBe(true);
      const failedPrompt = async () => {
        throw unrelated;
      };
      for (let logical = 0; logical < 6; logical += 1) {
        await expect(
          f.transcribe({ prompt: failedPrompt }),
        ).resolves.toMatchObject({ status: "failed" });
      }
      for (let logical = 0; logical < 6; logical += 1) {
        await expect(f.transcribe()).resolves.toMatchObject({
          status: "failed",
        });
      }
      expect(provider.calls).toHaveLength(6);
    },
  );
});

test("real bulkhead admits two active and one hundred queued jobs", async () => {
  const release = deferred<void>();
  const bothActive = deferred<void>();
  const provider = providerTransport(async (_prompt, attempt) => {
    if (attempt === 2) bothActive.resolve();
    await release.promise;
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  const controllers = Array.from({ length: 101 }, () => new AbortController());
  try {
    f.attachment.resolve();
    const active = [f.transcribe(), f.transcribe()];
    await bothActive.promise;
    const queued = controllers.map((controller) =>
      f.transcribe({ signal: controller.signal }),
    );
    await expect(queued[100]).resolves.toMatchObject({ status: "failed" });
    expect(provider.calls).toHaveLength(2);
    controllers.forEach((controller) => controller.abort());
    release.resolve();
    await Promise.all([...active, ...queued]);
    expect(provider.calls).toHaveLength(2);
  } finally {
    controllers.forEach((controller) => controller.abort());
    release.resolve();
    await f.dispose();
  }
});

test("real limiter spaces logical starts and records queue wait", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const starts: number[] = [];
  const provider = providerTransport(async () => Response.json(validResponse));
  try {
    await withTracingFixture(
      { realPolicies: true, transport: provider.fetch },
      async (f) => {
        f.attachment.resolve();
        f.preparePrompt.mockImplementation(async () => {
          // Admission precedes prompt and SDK preparation, which may delay dispatch.
          starts.push(performance.now());
          if (starts.length === 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
          return {
            prompt: "Project Orion delivery terminology.",
            langfusePrompt: undefined,
            source: "fallback" as const,
          };
        });
        const tasks = [f.transcribe(), f.transcribe()];
        await jest.advanceTimersByTimeAsync(1_000);
        await Promise.all(tasks);
        expect(starts).toHaveLength(2);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(780);
        expect(
          f.state.metadata?.transcriptionQueueWaitMs,
        ).toBeGreaterThanOrEqual(700);
      },
    );
  } finally {
    jest.useRealTimers();
  }
});

test("accounting failure preserves the vote error and attempts retained prompt usage", async () => {
  await withTracingFixture({ accountingFailure: true }, async (f) => {
    const providerError = new Error("original vote failure");
    f.create
      .mockResolvedValueOnce(uncertainResponse)
      .mockRejectedValueOnce(providerError);
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "failed",
    });
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.policyRejected).toHaveBeenCalledTimes(1);
    expect(f.policyRejected.mock.calls[0][0]).toBe(providerError);
    const accounting = f.update.mock.calls
      .map(([value]) => value)
      .find((value) => value.usageDetails);
    expect(accounting).toMatchObject({
      usageDetails: { input: 23, output: 11, total: 34 },
      metadata: { transcriptionRequestCount: 1 },
    });
  });
});
