/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/services/notesService", () => ({
  getNotes: jest.fn(async () => "- Synthetic generated note."),
}));
jest.mock("../../src/services/meetingSummaryService", () => ({
  generateMeetingSummaries: jest.fn(async () => ({
    summarySentence: "Synthetic generated summary.",
    summaryLabel: "Synthetic label",
  })),
}));
jest.mock("../../src/services/meetingNameService", () => ({
  resolveMeetingNameFromSummary: jest.fn(async () => "Synthetic meeting"),
}));
// The normal loader runs for real; the capture steps it calls are stubbed.
jest.mock("../../src/services/meetingCaptureWrapUp", () => ({
  settleCapturedAudio: jest.fn(async () => undefined),
  resolveMeetingCancellation: jest.fn(async () => ({ kind: "proceed" })),
  buildMeetingRecording: jest.fn(async () => "synthetic/missing-mix.mp3"),
  compileFinalTranscript: jest.fn(
    async (meeting: { finalTranscript?: string; processing?: object }) => {
      meeting.finalTranscript = "";
      meeting.processing = { transcription: "empty" };
    },
  ),
  compileTranscriptForUpload: jest.fn(async () => ""),
  compileCancelledTranscript: jest.fn(async () => undefined),
  captionMeetingImagesStep: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/transcriptCompilationService", () => ({
  createMeetingTranscriptCompiler: jest.fn(() => jest.fn(async () => "")),
}));
// The recovery loader runs for real; its cancellation check and mix are stubbed.
jest.mock("../../src/services/autoRecordCancellationService", () => ({
  ...jest.requireActual("../../src/services/autoRecordCancellationService"),
  decideAutoRecordCancellation: jest.fn(async () => ({ cancel: false })),
}));
jest.mock("../../src/services/mixedPcmService", () => ({
  renderMixedPcmTracks: jest.fn(async () => undefined),
}));

import { formatMeetingCaptureNotice } from "../../src/utils/meetingCaptureNotice";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import { resolveMeetingCancellation } from "../../src/services/meetingCaptureWrapUp";
import * as meetingDelivery from "../../src/services/meetingDelivery";
import * as embed from "../../src/embed";
import { getProcessingRetryEligibility } from "../../src/services/processingRetryEligibility";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { sumMeetingSecondsInWindow } from "../../src/services/meetingUsageService";
import { initialMeetingUpdatePolicy } from "../../src/types/meetingPublication";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
import type { MeetingData } from "../../src/types/meeting-data";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  createMeetingFinisher,
  nextDeliveryRetry,
  nextFinishRetry,
  type MeetingFinishDeps,
} from "../../src/services/meetingFinish";
import {
  loadNormalFinishInput,
  loadRecoveryFinishInput,
  type FinishInput,
} from "../../src/services/meetingFinishInput";
import { decideAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import { pcmArtifact, recoveryFixture } from "./meetingRecoveryFixtures";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../../src/services/meetingNotesService";
import { getNotes } from "../../src/services/notesService";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
import { captureEvent } from "../../src/services/analyticsService";
import { INTERRUPTED_CAPTURE_NOTICE } from "../../src/services/meetingRecoveryContent";
import {
  MEETING_DELIVERY_FAILED_LOG,
  MEETING_FINISH_FAILED_LOG,
} from "../../src/metrics";
import type { MeetingHistory } from "../../src/types/db";
import type { MeetingNotesInput } from "../../src/types/meeting-data";
import {
  EMPTY_RECORDING_NOTICE,
  PROCESSING_FAILED_NOTICE,
} from "../../src/utils/meetingProcessing";
import {
  DONE_MARKER,
  GUILD_ID,
  MEETING_SECONDS,
  START,
  START_MESSAGE_ID,
  TEXT_CHANNEL_ID,
  UPGRADE,
  VOICE_CHANNEL_ID,
  discordMessage,
  fakeDiscord,
  history,
  snowflake,
} from "./meetingDelivery.fixture";
import type { Client } from "discord.js";
import type { RecordingCheckpoint } from "../../src/types/recordingCheckpoint";

const OWNER = "synthetic-finisher";
const CREATOR_ID = "500";
const START_SECONDS = Date.parse(START) / 1000 + MEETING_SECONDS + 60;
const TRANSCRIPT = "Synthetic speaker: we agreed on a placeholder plan.";
const TRANSCRIPT_KEY = "synthetic/folder/transcript.json";
const FORBIDDEN = 403;
const SERVER_ERROR = 500;

const processingRow = (overrides: Partial<MeetingHistory> = {}) =>
  history({
    status: "processing",
    notes: undefined,
    summarySentence: undefined,
    processing: undefined,
    meetingCreatorId: CREATOR_ID,
    capture: {
      kind: "complete",
      startedAt: START,
      endedAt: new Date(
        Date.parse(START) + MEETING_SECONDS * 1000,
      ).toISOString(),
    },
    ...overrides,
  });

function notesInput(
  overrides: Partial<MeetingNotesInput> = {},
): MeetingNotesInput {
  return {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    generateNotes: true,
    transcribeMeeting: true,
    startTime: new Date(START),
    finalTranscript: TRANSCRIPT,
    processing: { transcription: "ready" },
    tags: ["alpha"],
    participants: new Map(),
    attendance: new Set(),
    creator: { id: CREATOR_ID },
    guild: { id: GUILD_ID, name: "", description: "" },
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "" },
    ...overrides,
  };
}

function finishInput(overrides: Partial<FinishInput> = {}): FinishInput {
  return {
    source: "recovery",
    notesInput: notesInput(),
    transcript: TRANSCRIPT,
    transcriptUpload: { key: TRANSCRIPT_KEY, body: Buffer.from("{}") },
    processing: { transcription: "ready" },
    participants: [{ id: CREATOR_ID, username: "synthetic-user" }],
    hasSavedAudio: true,
    ...overrides,
  };
}

function setup(initial: MeetingHistory) {
  const histories = new Map([[GUILD_ID, [structuredClone(initial)]]]);
  const repository = createMockMeetingFinishRepository(histories, new Map());
  const discord = fakeDiscord();
  let nowMs = START_SECONDS * 1000;
  let pending: (() => Promise<void>) | undefined;
  const deps: MeetingFinishDeps = {
    repository,
    transport: discord.transport,
    upload: jest.fn(async (key: string, body: string | Uint8Array) => ({
      key,
      versionId: null,
      byteLength: Buffer.byteLength(body),
      checksumSha256: "0".repeat(64),
    })),
    notes: jest.fn(ensureMeetingNotes),
    summaries: jest.fn(ensureMeetingSummaries),
    claimUpgrade: jest.fn(async () => undefined),
    followOns: {
      exportToNotion: jest.fn(async () => undefined),
      writeUserIndex: jest.fn(async () => undefined),
      captureCompleted: jest.fn(),
      sendWeeklyLimitNotice: jest.fn(async () => undefined),
    },
    nowMs: () => nowMs,
    schedule(run) {
      pending = run;
      return () => {
        pending = undefined;
      };
    },
  };
  const finisher = createMeetingFinisher(deps);
  const updates = createMeetingUpdateService({
    repository: createMockMeetingUpdateDeliveryRepository(
      histories,
      () => true,
    ),
    ready: async () => undefined,
    syncNotes: jest.fn(async () => undefined),
  });
  const current = () => histories.get(GUILD_ID)![0];
  const nowSeconds = () => Math.floor(nowMs / 1000);
  async function claim() {
    // A retry is claimable once its time arrives; the test clock jumps there.
    const due = current().finish?.nextAttemptAt;
    if (due !== undefined && due > nowSeconds()) nowMs = due * 1000;
    // Only the operator command claims a row the old runtime left unmarked.
    const claimed = await repository.claim(
      structuredClone(current()),
      OWNER,
      nowSeconds(),
      { operator: current().lifecycleVersion === undefined },
    );
    if (!claimed) throw new Error("expected a claim");
    return claimed;
  }
  return {
    deps,
    discord,
    current,
    finish: async (
      load: (signal: AbortSignal) => Promise<FinishInput>,
      options?: Parameters<typeof finisher.finishMeeting>[2],
    ) => finisher.finishMeeting(await claim(), load, options),
    claim,
    finisher,
    /** A rename through the real update action, as a portal correction makes it. */
    correct: (meetingName: string) =>
      updates({
        key: {
          guildId: initial.guildId,
          channelId_timestamp: initial.channelId_timestamp,
        },
        mutation: { kind: "rename", meetingName },
        actor: { editedBy: CREATOR_ID },
      }),
    scheduled: () => pending !== undefined,
    tick: async () => {
      const run = pending;
      if (!run) throw new Error("no renewal scheduled");
      pending = undefined;
      await run();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    posts: () => discord.requests.filter((r) => r.method === "POST"),
    edits: () => discord.requests.filter((r) => r.method === "PATCH"),
  };
}

const loads = (input: FinishInput) => jest.fn(async () => input);
const startMessage = (world: ReturnType<typeof setup>) =>
  world.discord.messages.find((message) => message.id === START_MESSAGE_ID)!;
const errorsLogged = (line: string) =>
  jest.mocked(console.error).mock.calls.filter(([first]) => first === line)
    .length;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("each step is skipped when its output exists", async () => {
  const world = setup(processingRow({ transcriptS3Key: TRANSCRIPT_KEY }));
  await world.finish(loads(finishInput()));
  expect(world.deps.upload).not.toHaveBeenCalled();
  expect(world.current()).toMatchObject({
    status: "complete",
    notes: "- Synthetic generated note.",
    summarySentence: "Synthetic generated summary.",
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

test("delivery backoff then hourly then give up at 24 hours", () => {
  const since = 1_000;
  const retry = (attempts: number, now: number) =>
    nextDeliveryRetry({ attempts, deliverSince: since }, now);
  expect(retry(0, since)).toBe(since + 60);
  expect(retry(1, since + 60)).toBe(since + 360);
  expect(retry(2, since + 360)).toBe(since + 1_260);
  expect(retry(3, since + 1_260)).toBe(since + 4_860);
  expect(retry(10, since + 30_000)).toBe(since + 33_600);
  const lastHour = since + LIFECYCLE.deliveryGiveUpSeconds - 600;
  expect(retry(20, lastHour)).toBe(since + LIFECYCLE.deliveryGiveUpSeconds);
  expect(retry(21, since + LIFECYCLE.deliveryGiveUpSeconds)).toBeUndefined();
  expect(nextDeliveryRetry({ attempts: 0 }, since)).toBe(since + 60);
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

test("an interrupted capture is saved as interrupted and its notes say the recording ended unexpectedly", async () => {
  const world = setup(
    processingRow({
      capture: {
        kind: "interrupted",
        startedAt: START,
        detectedAt: START,
        endedAt: null,
      },
    }),
  );
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

test("an attempt aborted before delivery claims no upgrade receipt", async () => {
  const world = setup(processingRow());
  const external = new AbortController();
  const save = world.deps.repository.save;
  world.deps.repository.save = async (...args) => {
    const saved = await save(...args);
    if (saved?.status === "complete") external.abort();
    return saved;
  };
  await world.finish(loads(finishInput()), { signal: external.signal });
  expect(world.current().status).toBe("complete");
  expect(world.deps.claimUpgrade).not.toHaveBeenCalled();
  expect(world.discord.requests).toHaveLength(0);
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

test("a temporary Discord error keeps the terminal status and retries delivery from its first failure", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = () => new Response("{}", { status: SERVER_ERROR });
  await world.finish(loads(finishInput()));
  const first = world.current().finish;
  expect(world.current().status).toBe("complete");
  expect(first).toMatchObject({
    attempts: 1,
    phase: "deliver",
    deliverSince: START_SECONDS,
    nextAttemptAt: START_SECONDS + 60,
  });
  await world.finish(loads(finishInput()));
  expect(world.current().finish).toMatchObject({
    attempts: 2,
    deliverSince: START_SECONDS,
  });
  world.discord.state.fail = undefined;
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({ recovery: DONE_MARKER });
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(0);
});

test("a permanent Discord error marks delivery failed without the alarm log", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = () => new Response("{}", { status: FORBIDDEN });
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "complete",
    delivery: {
      notes: {
        outcome: "failed",
        sent: 0,
        errors: [{ status: FORBIDDEN }],
      },
    },
  });
  expect(world.current().finish).toBeUndefined();
  expect(world.current().recovery).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(0);
});

test("a temporary Discord error past the give-up time marks delivery failed with the alarm log", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = () => new Response("{}", { status: SERVER_ERROR });
  await world.finish(loads(finishInput()));
  world.current().finish = {
    ...world.current().finish!,
    nextAttemptAt: START_SECONDS + LIFECYCLE.deliveryGiveUpSeconds,
  };
  await world.finish(loads(finishInput()));
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
});

test("a recording upload failure does not change the outcome", async () => {
  const world = setup(processingRow());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));
  const recordingPath = path.join(directory, "mixed.mp3");
  await fs.writeFile(recordingPath, "mp3");
  jest.mocked(world.deps.upload).mockImplementation(async (key, body) =>
    key.endsWith("audio_combined.mp3")
      ? Promise.reject(new Error("Synthetic storage outage"))
      : {
          key,
          versionId: null,
          byteLength: Buffer.byteLength(body),
          checksumSha256: "0".repeat(64),
        },
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));
  const recordingPath = path.join(directory, "mixed.mp3");
  await fs.writeFile(recordingPath, "mp3");
  await world.finish(
    loads(finishInput({ recordingPath, localDirectory: directory })),
  );
  expect(world.current().audioS3Key).toMatch(/audio_combined\.mp3$/);
});

test("deliver false posts nothing and leaves no finish marker", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput()), { deliver: false });
  expect(world.current().status).toBe("complete");
  expect(initialMeetingUpdatePolicy(world.current())).toEqual({
    kind: "unpublished",
  });
  expect(world.current().delivery).toBeUndefined();
  expect(world.current().recovery).toBeUndefined();
  expect(world.current().finish).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
  expect(world.deps.followOns.sendWeeklyLimitNotice).not.toHaveBeenCalled();
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(1);
});

test("the upgrade offer is shown with the summary and its delivery recorded", async () => {
  const world = setup(processingRow());
  jest.mocked(world.deps.claimUpgrade).mockResolvedValue(UPGRADE);
  await world.finish(loads(finishInput()));
  expect(JSON.stringify(startMessage(world).components)).toContain(UPGRADE.url);
  expect(
    jest
      .mocked(captureEvent)
      .mock.calls.filter(([name]) => name === "upgrade_offer_delivered")
      .map(([, event]) => event?.properties?.surface),
  ).toEqual(["discord_summary", "discord_notes"]);
});

test("an upgrade lookup failure never blocks delivery", async () => {
  const world = setup(processingRow());
  jest
    .mocked(world.deps.claimUpgrade)
    .mockRejectedValue(new Error("Synthetic billing outage"));
  await world.finish(loads(finishInput()));
  expect(world.current().recovery).toEqual(DONE_MARKER);
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
        notes: "- Synthetic generated note.",
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

const NOTICE_MESSAGE_ID = snowflake(Date.parse(START) + 5_000);
const CHECKPOINT: RecordingCheckpoint = {
  artifactFolder: "synthetic/folder/",
  schemaVersion: 1,
  revision: 1,
  capture: {
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    channelId_timestamp: `${VOICE_CHANNEL_ID}#${START}`,
    meetingId: "meeting-synthetic",
    ownerInstanceId: "instance-synthetic",
    executionVersion: 1,
    reservedAt: START,
    captureStartedAt: START,
    requested: { transcribeMeeting: true, generateNotes: true },
  },
  manifest: {
    key: "synthetic/folder/manifest.json",
    checksumSha256: "0".repeat(64),
    byteLength: 1,
  },
};

/** A live meeting in which nobody spoke, for the real normal loader. */
function silentMeeting(overrides: Partial<MeetingData> = {}): MeetingData {
  const value = {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    transcribeMeeting: true,
    generateNotes: true,
    isAutoRecording: false,
    startTime: new Date(START),
    tags: [],
    participants: new Map(),
    attendance: new Set(),
    creator: { id: CREATOR_ID },
    guild: { id: GUILD_ID, name: "Synthetic server", description: "" },
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "Synthetic voice" },
    audioData: { audioFiles: [] },
    chatLog: [],
    ...overrides,
  };
  return value as unknown as MeetingData;
}
const normalLoad = (meeting: MeetingData) => (signal: AbortSignal) =>
  loadNormalFinishInput(meeting, {} as Client, signal);

async function recordingDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));
  const recordingPath = path.join(directory, "mixed.mp3");
  await fs.writeFile(recordingPath, "mp3");
  return { directory, recordingPath };
}
const exists = (directory: string) =>
  fs.stat(directory).then(
    () => true,
    () => false,
  );

test("auto-record cancel with no speech ends cancelled with the cancelled embed", async () => {
  jest.mocked(resolveMeetingCancellation).mockResolvedValueOnce({
    kind: "automatic",
    decision: { cancel: true, reason: "Synthetic: not enough speech." },
  });
  const world = setup(
    processingRow({
      isAutoRecording: true,
      startTriggeredByUserId: CREATOR_ID,
      autoRecordRule: { mode: "channel", channelId: VOICE_CHANNEL_ID },
      endReason: "channel_empty",
    }),
  );
  world.discord.messages.push(
    discordMessage(NOTICE_MESSAGE_ID, { content: "Auto-recording started" }),
  );
  await world.finish(
    normalLoad(
      silentMeeting({
        isAutoRecording: true,
        messagesToDelete: [NOTICE_MESSAGE_ID],
      }),
    ),
  );
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "auto_cancelled",
    cancellationReason: "Synthetic: not enough speech.",
    recovery: DONE_MARKER,
  });
  expect(startMessage(world).embeds[0]).toMatchObject({
    title: "Auto-Recording Cancelled",
  });
  expect(
    world.discord.messages.some((message) => message.id === NOTICE_MESSAGE_ID),
  ).toBe(false);
  expect(world.posts()).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

test("a recovered auto-recording cancelled by the evaluation ends cancelled with the cancelled message and no notes", async () => {
  const PIECE_BYTES = 3840;
  const undecided = {
    policy: {
      enabled: true,
      maximumSeconds: 90,
      maximumWords: 50,
      maximumChatMessages: 1,
      dismissedMinimumMilliseconds: 600_000,
      dismissedMinimumChatMessages: 2,
    },
    isAutoRecording: true,
    elapsedMilliseconds: 30_000,
    chatMessageCount: 0,
    dismissed: false,
    decision: "undecided" as const,
  };
  const saved = await recoveryFixture("Synthetic short chatter.", {
    artifacts: [
      pcmArtifact("user:123", 0, Buffer.alloc(PIECE_BYTES, 1), [
        { startOffsetMs: 0, durationMs: 20 },
      ]),
    ],
    transcript: (transcript) => {
      transcript.entries[0].correspondence = {
        kind: "pcm",
        spans: [
          {
            sourceId: "user:123",
            sequence: 0,
            startByte: 0,
            endByte: PIECE_BYTES,
          },
        ],
      };
    },
  });
  jest.mocked(decideAutoRecordCancellation).mockResolvedValueOnce({
    cancel: true,
    reason: "Synthetic: not enough speech.",
  });
  const row = processingRow({
    isAutoRecording: true,
    startTriggeredByUserId: CREATOR_ID,
    autoRecordRule: { mode: "channel", channelId: VOICE_CHANNEL_ID },
    endReason: "channel_empty",
    completionPolicy: undecided,
  });
  const world = setup(row);
  await world.finish((signal) =>
    loadRecoveryFinishInput(
      {
        ...saved.claim.history,
        isAutoRecording: true,
        capture: row.capture,
        completionPolicy: undecided,
      },
      signal,
      saved.reader,
    ),
  );
  expect(decideAutoRecordCancellation).toHaveBeenCalledTimes(1);
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "auto_cancelled",
    cancellationReason: "Synthetic: not enough speech.",
    completionPolicy: { decision: "cancel" },
    recovery: DONE_MARKER,
  });
  expect(world.current().notes).toBeUndefined();
  expect(startMessage(world).embeds[0]).toMatchObject({
    title: "Auto-Recording Cancelled",
  });
  expect(getNotes).not.toHaveBeenCalled();
  expect(world.posts()).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

test("a cancel decision close wrote is kept when the loader would proceed", async () => {
  const completionPolicy = {
    policy: {
      enabled: true,
      maximumSeconds: 90,
      maximumWords: 50,
      maximumChatMessages: 1,
      dismissedMinimumMilliseconds: 600_000,
      dismissedMinimumChatMessages: 2,
    },
    isAutoRecording: true,
    elapsedMilliseconds: 1_000,
    chatMessageCount: 0,
    dismissed: true,
    decision: "cancel" as const,
  };
  const world = setup(
    processingRow({
      isAutoRecording: true,
      startTriggeredByUserId: CREATOR_ID,
      autoRecordRule: { mode: "channel", channelId: VOICE_CHANNEL_ID },
      endReason: "dismissed",
      cancellationReason: "Stopped by synthetic user",
      completionPolicy,
    }),
  );
  world.discord.messages.push(
    discordMessage(NOTICE_MESSAGE_ID, { content: "Auto-recording started" }),
  );
  await world.finish(
    normalLoad(
      silentMeeting({
        isAutoRecording: true,
        messagesToDelete: [NOTICE_MESSAGE_ID],
      }),
    ),
  );
  expect(
    world.discord.messages.some((message) => message.id === NOTICE_MESSAGE_ID),
  ).toBe(false);
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "dismissed",
    cancellationReason: "Stopped by synthetic user",
    completionPolicy: { decision: "cancel" },
  });
  expect(world.posts()).toHaveLength(0);
});

test("a manual meeting with no speech ends complete with the no-speech notice and is not metered", async () => {
  const world = setup(processingRow());
  const state = { durationContent: "Synthetic duration notice." };
  await world.finish(
    normalLoad(silentMeeting({ recordingLimitNotice: state })),
  );
  const row = world.current();
  expect(row).toMatchObject({
    status: "complete",
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
    recovery: DONE_MARKER,
  });
  expect(row.notes).toBeUndefined();
  expect(startMessage(world).embeds[0]).toMatchObject({
    description: "Summary unavailable.",
  });
  expect(JSON.stringify(world.discord.messages)).toContain(
    EMPTY_RECORDING_NOTICE,
  );
  expect(
    sumMeetingSecondsInWindow([row], 0, Date.parse(START) + 86_400_000),
  ).toBe(0);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledWith(
    expect.objectContaining({ meetingId: row.meetingId }),
    state,
    expect.anything(),
  );
});

test("a recovered capture that ended complete with no saved audio ends complete with the no-speech notice and is not metered", async () => {
  const row = processingRow();
  // The completed final flush recorded the capture as complete in the manifest.
  const saved = await recoveryFixture("Synthetic unused text.", {
    timestamp: START,
    captureState: { kind: "complete", startedAt: START, endedAt: START },
  });
  const world = setup(row);
  await world.finish((signal) =>
    loadRecoveryFinishInput(
      { ...saved.claim.history, capture: row.capture },
      signal,
      saved.reader,
    ),
  );
  const finished = world.current();
  expect(finished).toMatchObject({
    status: "complete",
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
    recovery: DONE_MARKER,
  });
  expect(finished.notes).toBeUndefined();
  expect(startMessage(world).embeds[0]).toMatchObject({
    description: "Summary unavailable.",
  });
  expect(JSON.stringify(world.discord.messages)).toContain(
    EMPTY_RECORDING_NOTICE,
  );
  expect(
    sumMeetingSecondsInWindow([finished], 0, Date.parse(START) + 86_400_000),
  ).toBe(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

test("the chat log is uploaded before the transcript and each key saved as it lands", async () => {
  const world = setup(processingRow());
  const save = jest.spyOn(world.deps.repository, "save");
  const entry = {
    type: "message" as const,
    user: { id: CREATOR_ID, username: "synthetic-user" },
    channelId: TEXT_CHANNEL_ID,
    content: "Synthetic chat line.",
    timestamp: START,
  };
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
  jest.mocked(world.deps.upload).mockImplementation(async (key, body) =>
    key === TRANSCRIPT_KEY
      ? undefined
      : {
          key,
          versionId: null,
          byteLength: Buffer.byteLength(body),
          checksumSha256: "0".repeat(64),
        },
  );
  const entry = {
    type: "message" as const,
    user: { id: CREATOR_ID, username: "synthetic-user" },
    channelId: TEXT_CHANNEL_ID,
    content: "Synthetic chat line.",
    timestamp: START,
  };
  await world.finish(loads(finishInput({ chatEntries: [entry] })));
  expect(world.current()).toMatchObject({
    status: "processing",
    finish: { attempts: 1 },
  });
  expect(world.current().chatS3Key).toMatch(/chat.json$/);
});

test("a worker stopped after delivery settles: the next attempt exports to Notion, uploads the recording and releases", async () => {
  const world = setup(processingRow({ checkpoint: CHECKPOINT }));
  let stopped: () => void = () => undefined;
  const reachedFollowOns = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  jest
    .mocked(world.deps.followOns.writeUserIndex)
    .mockImplementationOnce(() => {
      stopped();
      return new Promise(() => undefined);
    });
  void world.finish(loads(finishInput()));
  await reachedFollowOns;
  expect(world.current().recovery).toEqual(DONE_MARKER);
  expect(world.deps.followOns.exportToNotion).not.toHaveBeenCalled();

  world.advance((LIFECYCLE.finishClaimSeconds + 1) * 1000);
  const { directory, recordingPath } = await recordingDirectory();
  const load = loads(finishInput({ recordingPath, localDirectory: directory }));
  await world.finish(load);
  expect(load).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(1);
  expect(world.current().audioS3Key).toMatch(/audio_combined\.mp3$/);
  expect(world.current().finish).toBeUndefined();
  expect(await exists(directory)).toBe(false);
  expect(world.deps.followOns.captureCompleted).not.toHaveBeenCalled();
});

test("analytics and the weekly notice are not repeated on a settled row", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput({ source: "normal" })));
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledTimes(1);
  world.current().finish = { attempts: 0, phase: "deliver" };
  await world.finish(loads(finishInput({ source: "normal" })));
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(2);
});

test("an unexpected error during delivery is counted and gives up at 24 hours", async () => {
  const world = setup(processingRow());
  jest
    .spyOn(meetingDelivery, "deliverMeeting")
    .mockRejectedValue(new Error("Synthetic render defect"));
  await world.finish(loads(finishInput()));
  expect(world.current().finish).toMatchObject({
    attempts: 1,
    phase: "deliver",
    deliverSince: START_SECONDS,
  });
  world.current().finish = {
    ...world.current().finish!,
    nextAttemptAt: START_SECONDS + LIFECYCLE.deliveryGiveUpSeconds,
  };
  await world.finish(loads(finishInput()));
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
});

test("a correction made while delivery is pending is held and delivered after delivery completes", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = () => new Response("{}", { status: SERVER_ERROR });
  await world.finish(loads(finishInput()));
  expect(world.current().status).toBe("complete");
  await expect(world.correct("Synthetic edit")).resolves.toMatchObject({
    kind: "saved",
  });
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  world.discord.state.fail = undefined;
  await world.finish(loads(finishInput()));
  expect(world.current().recovery).toEqual(DONE_MARKER);
  expect(world.current().updateDelivery?.policy).toEqual({ kind: "active" });
  expect(world.current().updateDeliveryDueAt).toBeDefined();
});

test("a correction held when delivery is given up is released as unpublished", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = () => new Response("{}", { status: SERVER_ERROR });
  await world.finish(loads(finishInput()));
  await world.correct("Synthetic edit");
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  world.discord.state.fail = () => new Response("{}", { status: FORBIDDEN });
  await world.finish(loads(finishInput()));
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "unpublished",
  });
  expect(world.current().finish).toBeUndefined();
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

test("delivery gives up at 24 hours even when rendering the notes throws", async () => {
  const world = setup(processingRow());
  jest.spyOn(embed, "buildMeetingResultMessages").mockImplementation(() => {
    throw new Error("Synthetic renderer defect");
  });
  const done = jest.spyOn(world.deps.repository, "releaseDone");
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "complete",
    finish: { attempts: 1, phase: "deliver" },
  });
  world.current().finish = {
    ...world.current().finish!,
    nextAttemptAt: START_SECONDS + LIFECYCLE.deliveryGiveUpSeconds,
  };
  await world.finish(loads(finishInput()));
  expect(world.current().delivery?.notes).toMatchObject({
    outcome: "failed",
    sent: 0,
  });
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
  expect(done).toHaveBeenCalledTimes(1);
  expect(world.current().finish).toBeUndefined();
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

test("a row with no text channel is not held while its delivery is pending", () => {
  const pending = processingRow({
    status: "complete",
    notes: "- Synthetic note.",
    finish: { attempts: 0, phase: "deliver" },
  });
  expect(initialMeetingUpdatePolicy(pending)).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  expect(
    initialMeetingUpdatePolicy({ ...pending, textChannelId: undefined }),
  ).toEqual({ kind: "unpublished" });
});

test("a correction made during a deliver false attempt is released as unpublished", async () => {
  const world = setup(processingRow());
  let heldDuringAttempt: unknown;
  jest
    .mocked(world.deps.followOns.writeUserIndex)
    .mockImplementationOnce(async () => {
      await world.correct("Synthetic edit");
      heldDuringAttempt = world.current().updateDelivery?.policy;
    });
  await world.finish(loads(finishInput()), { deliver: false });
  expect(heldDuringAttempt).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "unpublished",
  });
  expect(world.current().finish).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
});

describe("deliver false leaves the meeting settled and unpublished", () => {
  const leftoverRecovery = {
    disposition: "pending" as const,
    attempt: 0,
    executionVersion: 1,
    stage: "verification" as const,
    retry: { maxAttempts: 3, nextAttemptAt: null },
  };
  const rows = {
    "a row the old runtime stranded with a recovery value": () =>
      processingRow({
        lifecycleVersion: undefined,
        recovery: leftoverRecovery,
      }),
    "a row of the lifecycle design": () => processingRow(),
  };

  function expectSettledAndUnpublished(row: MeetingHistory) {
    expect(row.recovery).toBeUndefined();
    expect(row.finish).toBeUndefined();
    expect(row.publicationRepair).toBeUndefined();
    expect(getProcessingRetryEligibility(row)).toEqual({
      eligible: false,
      reason: "nothing_failed",
    });
    expect(initialMeetingUpdatePolicy(row)).toEqual({ kind: "unpublished" });
    expect(projectMeetingUpdateDelivery(row)).toMatchObject({
      status: "unpublished",
    });
  }

  test.each(Object.entries(rows))("%s", async (_, row) => {
    const world = setup(row());
    await world.finish(loads(finishInput()), { deliver: false });
    expect(world.current().status).toBe("complete");
    expectSettledAndUnpublished(world.current());
    // A later correction is stored and not sent.
    await world.correct("Synthetic edit");
    expect(world.current()).toMatchObject({
      meetingName: "Synthetic edit",
      updateDelivery: { policy: { kind: "unpublished" } },
    });
    expect(world.discord.requests).toHaveLength(0);
  });

  test("an old row whose notes delivery already failed loses its leftover recovery value too", async () => {
    const world = setup(
      processingRow({
        lifecycleVersion: undefined,
        status: "complete",
        notes: "- Synthetic note.",
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
        recovery: leftoverRecovery,
        delivery: {
          notes: { outcome: "failed", intended: 1, sent: 0, errors: [] },
        },
      }),
    );
    await world.finish(loads(finishInput()), { deliver: false });
    expect(world.current().status).toBe("complete");
    expect(world.current().delivery?.notes?.outcome).toBe("failed");
    expectSettledAndUnpublished(world.current());
  });

  test("a delivered finish of an old row writes the done marker as before", async () => {
    const world = setup(
      rows["a row the old runtime stranded with a recovery value"](),
    );
    await world.finish(loads(finishInput()));
    expect(world.current().recovery).toEqual(DONE_MARKER);
  });
});
