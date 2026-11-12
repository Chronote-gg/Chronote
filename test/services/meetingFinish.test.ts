/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService");
jest.mock("../../src/services/notesService");
jest.mock("../../src/services/meetingSummaryService");
jest.mock("../../src/services/meetingNameService");

import { formatMeetingCaptureNotice } from "../../src/utils/meetingCaptureNotice";
import { promises as fs } from "node:fs";
import { getProcessingRetryEligibility } from "../../src/services/processingRetryEligibility";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { nextFinishRetry } from "../../src/services/meetingFinish";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import { getNotes } from "../../src/services/notesService";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
import { INTERRUPTED_CAPTURE_NOTICE } from "../../src/services/meetingRecoveryContent";
import { MEETING_FINISH_FAILED_LOG } from "../../src/metrics";
import type { MeetingHistory } from "../../src/types/db";
import { PROCESSING_FAILED_NOTICE } from "../../src/utils/meetingProcessing";
import { storedObject } from "../fixtures/meetingFinishPipeline";
import {
  DONE_MARKER,
  START,
  TEXT_CHANNEL_ID,
  VOICE_CHANNEL_ID,
} from "./meetingDelivery.fixture";
import {
  CHECKPOINT,
  CREATOR_ID,
  GENERATED_NOTE,
  GENERATED_SUMMARY,
  OWNER,
  TRANSCRIPT_KEY,
  chatEntry,
  errorsLogged,
  exists,
  finishInput,
  loads,
  notesInput,
  processingRow,
  recordingDirectory,
  setup,
  startMessage,
  useMeetingFinishHooks,
  type FinishWorld,
} from "./meetingFinish.fixture";

useMeetingFinishHooks();

const ABANDONED_LOG = "Meeting finish attempt abandoned while still running";
const STOPPED_LOG = "Meeting finish attempt stopped";
const warned = (line: string) =>
  jest.mocked(console.warn).mock.calls.filter(([first]) => first === line)
    .length;

test("each step is skipped when its output exists", async () => {
  const world = setup(processingRow({ transcriptS3Key: TRANSCRIPT_KEY }));
  await world.finish(loads(finishInput()));
  expect(world.deps.upload).not.toHaveBeenCalled();
  expect(world.current()).toMatchObject({
    status: "complete",
    notes: GENERATED_NOTE,
    summarySentence: GENERATED_SUMMARY,
    recovery: DONE_MARKER,
    delivery: { notes: { outcome: "complete" } },
  });
  expect(world.current().finish).toBeUndefined();
  const requests = world.discord.requests.length;

  // A second run on the finished row repeats nothing.
  world.current().finish = { attempts: 0, phase: "deliver" };
  const load = loads(finishInput());
  await world.finish(load);
  expect(load).not.toHaveBeenCalled();
  expect(getNotes).toHaveBeenCalledTimes(1);
  expect(world.discord.requests).toHaveLength(requests);
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.writeUserIndex).toHaveBeenCalledTimes(2);
  expect(world.current().finish).toBeUndefined();
});

test("backoff 1, 5, 15 then final", () => {
  const now = 1_000;
  expect(
    [0, 1, 2, 3].map((attempts) => nextFinishRetry(attempts, now)),
  ).toEqual([now + 60, now + 300, now + 900, undefined]);
});

test("claim loss aborts the attempt", async () => {
  const world = setup(processingRow());
  let seen: AbortSignal | undefined;
  const load = jest.fn(
    (signal: AbortSignal) =>
      new Promise<FinishInput>((_, reject) => {
        seen = signal;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const save = jest.spyOn(world.deps.repository, "save");
  const release = jest.spyOn(world.deps.repository, "releaseForRetry");
  const done = jest.spyOn(world.deps.repository, "releaseDone");
  jest.spyOn(world.deps.repository, "renew").mockResolvedValue(false);
  const claim = await world.claim();
  const before = structuredClone(world.current());
  const finished = world.finisher.finishMeeting(claim, load);
  await world.tick();
  await finished;
  expect(seen?.aborted).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
  expect(world.current()).toEqual(before);
  expect(world.discord.requests).toHaveLength(0);
});

test("an attempt past its cap aborts like a lost claim", async () => {
  const world = setup(processingRow());
  let seen: AbortSignal | undefined;
  const finished = world.finish(
    (signal) =>
      new Promise<FinishInput>((_, reject) => {
        seen = signal;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  world.advance(LIFECYCLE.finishAttemptMaxMs);
  await world.tick();
  await finished;
  expect(seen?.aborted).toBe(true);
  expect(world.current().status).toBe("processing");
  // A cooperative attempt unwinds inside the grace, so nothing is abandoned.
  expect(world.scheduled()).toBe(false);
  expect(warned(ABANDONED_LOG)).toBe(0);
});

describe("an attempt that ignores its abort", () => {
  const ignoring = () => new Promise<FinishInput>(() => undefined);

  async function expectAbandoned(world: FinishWorld, finished: Promise<void>) {
    let returned = false;
    void finished.then(() => (returned = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    await world.graceEnds();
    await finished;
    expect(warned(ABANDONED_LOG)).toBe(1);
    expect(jest.mocked(console.warn)).toHaveBeenCalledWith(
      ABANDONED_LOG,
      expect.objectContaining({ meetingId: world.current().meetingId }),
    );
    expect(warned(STOPPED_LOG)).toBe(1);
    // As any aborted attempt: no retry is scheduled and no attempt is counted.
    expect(world.current()).toMatchObject({
      status: "processing",
      finish: { owner: OWNER, attempts: 0, phase: "process" },
    });
    expect(world.current().finish?.nextAttemptAt).toBeUndefined();
    expect(world.scheduled()).toBe(false);
  }

  test("is abandoned after the grace once it reaches its cap", async () => {
    const world = setup(processingRow());
    const finished = world.finish(ignoring);
    await new Promise((resolve) => setImmediate(resolve));
    world.advance(LIFECYCLE.finishAttemptMaxMs);
    await world.tick();
    await expectAbandoned(world, finished);
  });

  test("is abandoned after the grace once an outside signal aborts it", async () => {
    const world = setup(processingRow());
    const external = new AbortController();
    const finished = world.finish(ignoring, { signal: external.signal });
    await new Promise((resolve) => setImmediate(resolve));
    external.abort(new Error("Synthetic shutdown"));
    await expectAbandoned(world, finished);
  });

  test("leaves no unhandled rejection when the abandoned work later fails", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const world = setup(processingRow());
      const external = new AbortController();
      let fail: (error: Error) => void = () => undefined;
      const finished = world.finish(
        () =>
          new Promise<FinishInput>((_, reject) => {
            fail = reject;
          }),
        { signal: external.signal },
      );
      await new Promise((resolve) => setImmediate(resolve));
      external.abort(new Error("Synthetic shutdown"));
      await world.graceEnds();
      await finished;
      fail(new Error("Synthetic late failure"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

test("generation disabled saves a terminal status and posts no notes", async () => {
  const world = setup(processingRow({ generateNotes: false }));
  await world.finish(
    loads(finishInput({ notesInput: notesInput({ generateNotes: false }) })),
  );
  expect(getNotes).not.toHaveBeenCalled();
  expect(world.current()).toMatchObject({
    status: "complete",
    processing: {
      transcription: "ready",
      notes: "skipped",
      summary: "skipped",
    },
    recovery: DONE_MARKER,
  });
  expect(world.current().notes).toBeUndefined();
  expect(world.posts()).toHaveLength(0);
  expect(world.edits()).toHaveLength(1);
});

test("a cancelled meeting is saved as cancelled and the start message shows the cancellation", async () => {
  const world = setup(
    processingRow({
      isAutoRecording: true,
      startTriggeredByUserId: CREATOR_ID,
      autoRecordRule: { mode: "all", channelId: VOICE_CHANNEL_ID },
      endReason: "channel_empty",
    }),
  );
  await world.finish(
    loads(finishInput({ cancel: { reason: "Synthetic short meeting." } })),
  );
  expect(getNotes).not.toHaveBeenCalled();
  expect(world.current()).toMatchObject({
    status: "cancelled",
    cancellationReason: "Synthetic short meeting.",
    endReason: "auto_cancelled",
    recovery: DONE_MARKER,
  });
  expect(world.current().notes).toBeUndefined();
  const embed = startMessage(world).embeds[0];
  expect(embed).toMatchObject({
    title: "Auto-Recording Cancelled",
    fields: expect.arrayContaining([
      { name: "Reason", value: "Synthetic short meeting." },
      { name: "Triggered by", value: `<@${CREATOR_ID}>` },
    ]),
  });
  expect(world.posts()).toHaveLength(0);
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.sendWeeklyLimitNotice).not.toHaveBeenCalled();
});

const interruptedRow = (overrides: Partial<MeetingHistory> = {}) =>
  processingRow({
    capture: {
      kind: "interrupted",
      startedAt: START,
      detectedAt: START,
      endedAt: null,
    },
    ...overrides,
  });

test("an interrupted capture is saved as interrupted and its notes say the recording ended unexpectedly", async () => {
  const world = setup(interruptedRow());
  const captureNotice = `${INTERRUPTED_CAPTURE_NOTICE} Synthetic end time.`;
  await world.finish(
    loads(
      finishInput({
        processing: { transcription: "partial" },
        notesInput: notesInput({
          captureNotice,
          processing: { transcription: "partial" },
        }),
      }),
    ),
  );
  expect(getNotes).toHaveBeenCalledWith(
    expect.objectContaining({ captureNotice }),
  );
  expect(world.current()).toMatchObject({
    status: "interrupted",
    processing: { transcription: "partial", notes: "generated" },
  });
});

const CONFIRMED_COVERAGE = {
  kind: "verified" as const,
  savedDurationMs: 42_000,
  lastConfirmedCaptureAt: START,
};

test("an interrupted recovery saves the capture coverage its checkpoint confirms", async () => {
  const world = setup(interruptedRow());

  await world.finish(
    loads(finishInput({ captureCoverage: CONFIRMED_COVERAGE })),
  );

  expect(world.current()).toMatchObject({
    status: "interrupted",
    captureCoverage: CONFIRMED_COVERAGE,
  });
  // Discord, the portal, shares, MCP, export and corrections all render this notice from the row.
  expect(formatMeetingCaptureNotice(world.current())).toContain(
    "Confirmed saved audio: 42 seconds.",
  );
});

test("a capture coverage already on the row is kept", async () => {
  const world = setup(interruptedRow({ captureCoverage: { kind: "unknown" } }));

  await world.finish(
    loads(finishInput({ captureCoverage: CONFIRMED_COVERAGE })),
  );

  expect(world.current().captureCoverage).toEqual({ kind: "unknown" });
});

test("no saved audio ends failed without a notice", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput({ hasSavedAudio: false })));
  expect(world.current().status).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
  expect(world.deps.followOns.captureCompleted).not.toHaveBeenCalled();
});

test("an external abort schedules no retry and counts no attempt", async () => {
  const world = setup(processingRow());
  const external = new AbortController();
  const load = jest.fn(async (signal: AbortSignal) => {
    external.abort(new Error("Synthetic shutdown"));
    await Promise.resolve();
    signal.throwIfAborted();
    throw new Error("Synthetic load failure");
  });
  await world.finish(load, { signal: external.signal });
  expect(world.current()).toMatchObject({
    status: "processing",
    finish: { owner: OWNER, attempts: 0, phase: "process" },
  });
  expect(world.current().finish?.nextAttemptAt).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
  expect(world.deps.notes).not.toHaveBeenCalled();
});

test("an attempt started with an aborted signal does nothing", async () => {
  const world = setup(processingRow());
  const external = new AbortController();
  external.abort();
  const load = loads(finishInput());
  await world.finish(load, { signal: external.signal });
  expect(load).not.toHaveBeenCalled();
  expect(world.current().finish).toMatchObject({ owner: OWNER, attempts: 0 });
});

test("the fourth failure posts one processing-failed notice", async () => {
  const world = setup(processingRow());
  const load = jest.fn(async () => {
    throw new Error("Synthetic transcription failure");
  });
  for (const attempts of [1, 2, 3]) {
    await world.finish(load);
    expect(world.current()).toMatchObject({
      status: "processing",
      finish: { attempts, phase: "process" },
    });
    expect(world.current().finish?.owner).toBeUndefined();
  }
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
  await world.finish(load);
  expect(load).toHaveBeenCalledTimes(4);
  expect(world.current().status).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(world.edits()).toHaveLength(1);
  expect(startMessage(world).content).toBe(PROCESSING_FAILED_NOTICE);
  expect(world.posts()).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(1);
});

test("a failed notes generation is retried rather than saved", async () => {
  const world = setup(processingRow());
  jest.mocked(getNotes).mockRejectedValueOnce(new Error("Synthetic outage"));
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "processing",
    finish: { attempts: 1, phase: "process" },
  });
  expect(world.current().notes).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
});

test("a recording upload failure does not change the outcome", async () => {
  const world = setup(processingRow());
  const { directory, recordingPath } = await recordingDirectory();
  jest
    .mocked(world.deps.upload)
    .mockImplementation(async (key, body) =>
      key.endsWith("audio_combined.mp3")
        ? Promise.reject(new Error("Synthetic storage outage"))
        : storedObject(key, body),
    );
  await world.finish(
    loads(finishInput({ recordingPath, localDirectory: directory })),
  );
  expect(world.current()).toMatchObject({
    status: "complete",
    recovery: DONE_MARKER,
    transcriptS3Key: TRANSCRIPT_KEY,
  });
  expect(world.current().audioS3Key).toBeUndefined();
  expect(world.current().finish).toBeUndefined();
  expect(console.error).toHaveBeenCalledWith(
    "Meeting recording upload failed",
    expect.anything(),
  );
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a recording is uploaded and its key recorded", async () => {
  const world = setup(processingRow());
  const { directory, recordingPath } = await recordingDirectory();
  await world.finish(
    loads(finishInput({ recordingPath, localDirectory: directory })),
  );
  expect(world.current().audioS3Key).toMatch(/audio_combined\.mp3$/);
});

test("the terminal save records notes version fields, participants and tags", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    notesVersion: 1,
    notesLastEditedBy: CREATOR_ID,
    notesHistory: [
      {
        version: 1,
        notes: GENERATED_NOTE,
        editedBy: CREATOR_ID,
      },
    ],
    participants: [{ id: CREATOR_ID, username: "synthetic-user" }],
    tags: ["alpha"],
    textChannelId: TEXT_CHANNEL_ID,
  });
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(1);
  // A recovered meeting gets no weekly notice, as today.
  expect(world.deps.followOns.sendWeeklyLimitNotice).not.toHaveBeenCalled();
});

test("the chat log is uploaded before the transcript and each key saved as it lands", async () => {
  const world = setup(processingRow());
  const save = jest.spyOn(world.deps.repository, "save");
  const entry = chatEntry();
  await world.finish(loads(finishInput({ chatEntries: [entry] })));
  const uploaded = jest.mocked(world.deps.upload).mock.calls;
  const chatJson = uploaded.find(([key]) => key.endsWith("chat.json"));
  expect(JSON.parse(String(chatJson?.[1]))).toEqual([entry]);
  expect(
    String(uploaded.find(([key]) => key.endsWith("chat.txt"))?.[1]),
  ).toContain("Synthetic chat line.");
  expect(world.current().chatS3Key).toMatch(/chat\.json$/);
  expect(save.mock.calls[0][1]).toEqual({
    chatS3Key: world.current().chatS3Key,
  });
  expect(save.mock.calls[1][1]).toEqual({ transcriptS3Key: TRANSCRIPT_KEY });
});

test("a transcript upload failure keeps the chat log", async () => {
  const world = setup(processingRow());
  jest
    .mocked(world.deps.upload)
    .mockImplementation(async (key, body) =>
      key === TRANSCRIPT_KEY ? undefined : storedObject(key, body),
    );
  await world.finish(loads(finishInput({ chatEntries: [chatEntry()] })));
  expect(world.current()).toMatchObject({
    status: "processing",
    finish: { attempts: 1 },
  });
  expect(world.current().chatS3Key).toMatch(/chat.json$/);
});

test("the local directory survives a failed attempt and is removed after completion", async () => {
  const world = setup(processingRow());
  const { directory } = await recordingDirectory();
  const normal = { source: "normal" as const, localDirectory: directory };
  jest.mocked(getNotes).mockRejectedValueOnce(new Error("Synthetic outage"));
  await world.finish(loads(finishInput(normal)));
  expect(world.current().finish).toMatchObject({ attempts: 1 });
  expect(await exists(directory)).toBe(true);
  await world.finish(loads(finishInput(normal)));
  expect(world.current().finish).toBeUndefined();
  expect(await exists(directory)).toBe(false);
});

test("no renewal is scheduled after the attempt ends", async () => {
  const world = setup(processingRow());
  let renewed: (held: boolean) => void = () => undefined;
  jest.spyOn(world.deps.repository, "renew").mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        renewed = resolve;
      }),
  );
  let loaded: () => void = () => undefined;
  const load = () =>
    new Promise<FinishInput>((resolve) => {
      loaded = () => resolve(finishInput());
    });
  const claim = await world.claim();
  const finished = world.finisher.finishMeeting(claim, load);
  const renewal = world.tick();
  loaded();
  await finished;
  renewed(true);
  await renewal;
  expect(world.scheduled()).toBe(false);
});

test("a failed recovery attempt removes its temporary directory", async () => {
  const world = setup(processingRow());
  const { directory } = await recordingDirectory();
  jest.mocked(getNotes).mockRejectedValueOnce(new Error("Synthetic outage"));
  await world.finish(loads(finishInput({ localDirectory: directory })));
  expect(world.current().finish).toMatchObject({ attempts: 1 });
  expect(await exists(directory)).toBe(false);
});

test("a meeting the pipeline gave up on is eligible for a portal retry of the failed stages", async () => {
  const loadFailed = setup(processingRow({ checkpoint: CHECKPOINT }));
  const load = jest.fn(async () => {
    throw new Error("Synthetic transcription failure");
  });
  for (let attempt = 0; attempt < 4; attempt++) await loadFailed.finish(load);
  expect(loadFailed.current()).toMatchObject({
    status: "failed",
    processing: {
      transcription: "failed",
      notes: "skipped",
      summary: "skipped",
    },
  });
  expect(getProcessingRetryEligibility(loadFailed.current())).toMatchObject({
    eligible: true,
    stages: ["transcription", "notes", "summary"],
  });

  const notesFailed = setup(processingRow({ checkpoint: CHECKPOINT }));
  for (let attempt = 0; attempt < 4; attempt++) {
    jest.mocked(getNotes).mockRejectedValueOnce(new Error("Synthetic outage"));
    await notesFailed.finish(loads(finishInput()));
  }
  expect(notesFailed.current()).toMatchObject({
    status: "failed",
    processing: { transcription: "ready", notes: "failed" },
  });
  expect(getProcessingRetryEligibility(notesFailed.current())).toMatchObject({
    eligible: true,
    stages: ["notes", "summary"],
  });

  // Generated notes are not stored on a failed row, so they are recorded as failed too.
  const summaryFailed = setup(processingRow({ checkpoint: CHECKPOINT }));
  for (let attempt = 0; attempt < 4; attempt++) {
    jest
      .mocked(generateMeetingSummaries)
      .mockRejectedValueOnce(new Error("Synthetic outage"));
    await summaryFailed.finish(loads(finishInput()));
  }
  expect(summaryFailed.current()).toMatchObject({
    status: "failed",
    processing: { transcription: "ready", notes: "failed", summary: "failed" },
  });
  expect(summaryFailed.current().notes).toBeUndefined();
  expect(getProcessingRetryEligibility(summaryFailed.current())).toMatchObject({
    eligible: true,
    stages: ["notes", "summary"],
  });
});

test("a cancelled meeting that gives up records no processing outcome", async () => {
  const world = setup(processingRow({ checkpoint: CHECKPOINT }));
  jest.mocked(world.deps.upload).mockResolvedValue(undefined);
  for (let attempt = 0; attempt < 4; attempt++)
    await world.finish(
      loads(finishInput({ cancel: { reason: "Synthetic short meeting." } })),
    );
  expect(world.current().status).toBe("failed");
  expect(world.current().processing).toBeUndefined();
});
