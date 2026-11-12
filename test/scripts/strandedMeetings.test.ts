/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
  shutdownAnalytics: jest.fn(async () => undefined),
}));

import {
  finishStranded,
  listStranded,
  parseStrandedArgs,
  resultMessage,
  type FinishStrandedDeps,
} from "../../scripts/stranded-meetings";
import { createMockMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import {
  createMeetingFinisher,
  type MeetingFinishDeps,
} from "../../src/services/meetingFinish";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { MeetingNotesInput } from "../../src/types/meeting-data";
import type { RecordingCheckpoint } from "../../src/types/recordingCheckpoint";
import { getProcessingRetryEligibility } from "../../src/services/processingRetryEligibility";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
import { initialMeetingUpdatePolicy } from "../../src/types/meetingPublication";
import {
  GUILD_ID,
  MEETING_SECONDS,
  START,
  VOICE_CHANNEL_ID,
  fakeDiscord,
  history,
} from "../services/meetingDelivery.fixture";

const MS_PER_SECOND = 1000;
const NOW_MS = Date.parse(START) + (MEETING_SECONDS + 60) * MS_PER_SECOND;
const GUILD_SNOWFLAKE = "222222222222222222";
const KEY = {
  guildId: GUILD_ID,
  channelId_timestamp: `${VOICE_CHANNEL_ID}#${START}`,
};
const TRANSCRIPT = "Synthetic speaker: we agreed on a placeholder plan.";

/** A meeting the old runtime left unfinished: no lifecycle marker, no finish map. */
const strandedRow = (overrides: Partial<MeetingHistory> = {}) =>
  history({
    lifecycleVersion: undefined,
    status: "processing",
    notes: undefined,
    summarySentence: undefined,
    processing: undefined,
    updatedAt: START,
    ...overrides,
  });

function notesInput(): MeetingNotesInput {
  return {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    generateNotes: true,
    transcribeMeeting: true,
    startTime: new Date(START),
    finalTranscript: TRANSCRIPT,
    processing: { transcription: "ready" },
    tags: [],
    participants: new Map(),
    attendance: new Set(),
    creator: { id: "500" },
    guild: { id: GUILD_ID, name: "", description: "" },
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "" },
  };
}

const recoveredInput = (): FinishInput => ({
  source: "recovery",
  notesInput: notesInput(),
  transcript: TRANSCRIPT,
  transcriptUpload: {
    key: "synthetic/folder/transcript.json",
    body: Buffer.from("{}"),
  },
  processing: { transcription: "ready" },
  participants: [{ id: "500", username: "synthetic-user" }],
  hasSavedAudio: true,
});

function setup(initial: MeetingHistory) {
  const histories = new Map([[GUILD_ID, [structuredClone(initial)]]]);
  const repository = createMockMeetingFinishRepository(histories, new Map());
  const discord = fakeDiscord();
  let nowMs = NOW_MS;
  const notes = jest.fn(async (input: MeetingNotesInput) => {
    input.notesText = "- Synthetic note.";
    input.processing = { ...input.processing, notes: "generated" };
    return input.notesText;
  });
  const pipeline: MeetingFinishDeps = {
    repository,
    transport: discord.transport,
    upload: jest.fn(async (key: string, body: string | Uint8Array) => ({
      key,
      versionId: null,
      byteLength: Buffer.byteLength(body),
      checksumSha256: "0".repeat(64),
    })),
    notes,
    summaries: jest.fn(async () => ({})),
    claimUpgrade: jest.fn(async () => undefined),
    followOns: {
      exportToNotion: jest.fn(async () => undefined),
      writeUserIndex: jest.fn(async () => undefined),
      captureCompleted: jest.fn(),
      sendWeeklyLimitNotice: jest.fn(async () => undefined),
    },
    nowMs: () => nowMs,
    schedule: () => () => undefined,
  };
  const finisher = createMeetingFinisher(pipeline);
  const deps: FinishStrandedDeps = {
    repository,
    finish: finisher.finishMeeting,
    loadRecovery: jest.fn(async () => recoveredInput()),
    readCoverage: jest.fn(),
    readLease: jest.fn(async () => undefined),
    nowMs: () => nowMs,
    sleep: jest.fn(async (ms: number) => {
      nowMs += ms;
    }),
  };
  return {
    deps,
    discord,
    notes,
    nowSeconds: () => Math.floor(nowMs / MS_PER_SECOND),
    current: () => histories.get(GUILD_ID)![0],
  };
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("parseStrandedArgs", () => {
  const key = [GUILD_SNOWFLAKE, `333333333333333333#${START}`];

  test("finish needs exactly one of --post and --no-post", () => {
    expect(parseStrandedArgs(["finish", ...key, "--post"])).toEqual({
      kind: "finish",
      key: { guildId: GUILD_SNOWFLAKE, channelId_timestamp: key[1] },
      deliver: true,
    });
    expect(parseStrandedArgs(["finish", ...key, "--no-post"])).toMatchObject({
      deliver: false,
    });
    expect(() => parseStrandedArgs(["finish", ...key])).toThrow(
      "exactly one of --post or --no-post",
    );
    expect(() =>
      parseStrandedArgs(["finish", ...key, "--post", "--no-post"]),
    ).toThrow("exactly one of --post or --no-post");
  });

  test("finish needs a guild id and a meeting key", () => {
    expect(() =>
      parseStrandedArgs(["finish", GUILD_SNOWFLAKE, "--post"]),
    ).toThrow("Usage");
    expect(() =>
      parseStrandedArgs(["finish", "not-a-guild", key[1], "--post"]),
    ).toThrow();
  });

  test("list needs a new output directory and takes no post flags", () => {
    expect(parseStrandedArgs(["list", "--out", "private-out"])).toEqual({
      kind: "list",
      out: "private-out",
    });
    expect(() => parseStrandedArgs(["list"])).toThrow("Usage");
    expect(() =>
      parseStrandedArgs(["list", "--out", "private-out", "--post"]),
    ).toThrow("Usage");
    expect(() => parseStrandedArgs(["--unknown"])).toThrow();
  });
});

describe("finishStranded", () => {
  test("--no-post finishes the meeting, posts nothing and leaves no marker", async () => {
    const world = setup(strandedRow());
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "finished",
    );
    expect(world.current()).toMatchObject({
      status: "complete",
      notes: "- Synthetic note.",
    });
    expect(world.current().finish).toBeUndefined();
    expect(world.current().lifecycleVersion).toBeUndefined();
    expect(world.discord.requests).toEqual([]);
  });

  test("--no-post on a row with a leftover recovery value leaves it settled and unpublished", async () => {
    const world = setup(
      strandedRow({
        recovery: {
          disposition: "needs_reconciliation",
          attempt: 1,
          executionVersion: 1,
          stage: "delivery",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        },
      }),
    );
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "finished",
    );
    const row = world.current();
    expect(row.recovery).toBeUndefined();
    expect(row.publicationRepair).toBeUndefined();
    expect(getProcessingRetryEligibility(row)).toEqual({
      eligible: false,
      reason: "nothing_failed",
    });
    expect(initialMeetingUpdatePolicy(row)).toEqual({ kind: "unpublished" });
    expect(projectMeetingUpdateDelivery(row)).toMatchObject({
      status: "unpublished",
    });
    expect(world.discord.requests).toEqual([]);
  });

  test("--post on a row with a leftover recovery value delivers it and writes the done marker", async () => {
    const world = setup(
      strandedRow({
        recovery: {
          disposition: "pending",
          attempt: 0,
          executionVersion: 1,
          stage: "verification",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        },
      }),
    );
    await expect(finishStranded(KEY, true, world.deps)).resolves.toBe(
      "finished",
    );
    expect(world.current().recovery?.disposition).toBe("done");
  });

  test("--post finishes the meeting and delivers it", async () => {
    const world = setup(strandedRow());
    await expect(finishStranded(KEY, true, world.deps)).resolves.toBe(
      "finished",
    );
    expect(world.current().recovery?.disposition).toBe("done");
    expect(
      world.discord.requests.filter((request) => request.method === "POST"),
    ).not.toHaveLength(0);
  });

  test("a failure that outlasts its retries leaves the row as it found it", async () => {
    const before = strandedRow({ status: "in_progress", capture: undefined });
    const world = setup(before);
    world.notes.mockRejectedValue(new Error("synthetic notes failure"));

    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "restored",
    );

    expect(world.notes).toHaveBeenCalledTimes(3);
    expect(world.deps.sleep).toHaveBeenCalledTimes(2);
    expect(world.current()).toEqual(before);
    expect(world.discord.requests).toEqual([]);
  });

  test("a meeting with no saved audio is reported failed", async () => {
    const world = setup(strandedRow());
    jest
      .mocked(world.deps.loadRecovery)
      .mockResolvedValue({ ...recoveredInput(), hasSavedAudio: false });
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "failed",
    );
    expect(world.current()).toMatchObject({ status: "failed" });
  });

  test("a meeting that gives up after its retries is reported failed", async () => {
    // An earlier run recorded three failures, so the next one is final.
    const world = setup(
      strandedRow({ finish: { attempts: 3, phase: "process" } }),
    );
    world.notes.mockRejectedValue(new Error("synthetic notes failure"));
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "failed",
    );
    expect(world.current().status).toBe("failed");
    expect(world.current().finish).toBeUndefined();
    expect(world.discord.requests).toEqual([]);
  });

  test("--post with a permanent Discord error is reported delivery_failed", async () => {
    const world = setup(strandedRow());
    world.discord.state.fail = (request) =>
      request.method === "POST"
        ? new Response(JSON.stringify({ code: 50013 }), { status: 403 })
        : undefined;
    await expect(finishStranded(KEY, true, world.deps)).resolves.toBe(
      "delivery_failed",
    );
    expect(world.current()).toMatchObject({
      status: "complete",
      delivery: { notes: { outcome: "failed" } },
    });
  });

  test("an interrupt stops the attempt and leaves the row as it found it", async () => {
    const before = strandedRow({ status: "in_progress", capture: undefined });
    const world = setup(before);
    const interrupt = new AbortController();
    jest.mocked(world.deps.loadRecovery).mockImplementation(async (_h, s) => {
      interrupt.abort();
      await Promise.resolve();
      s.throwIfAborted();
      return recoveredInput();
    });
    await expect(
      finishStranded(KEY, false, world.deps, interrupt.signal),
    ).resolves.toBe("interrupted");
    expect(world.deps.loadRecovery).toHaveBeenCalledTimes(1);
    expect(world.current()).toEqual(before);
  });

  test("an interrupt during delivery hands the claim back", async () => {
    const world = setup(
      strandedRow({
        status: "complete",
        notes: "- Synthetic note.",
        finish: { attempts: 1, phase: "deliver" },
      }),
    );
    const interrupt = new AbortController();
    world.discord.state.fail = () => {
      interrupt.abort();
      return undefined;
    };
    await expect(
      finishStranded(KEY, true, world.deps, interrupt.signal),
    ).resolves.toBe("delivery_pending");
    expect(world.current().finish).toEqual({
      attempts: 1,
      phase: "deliver",
      startedAt: world.nowSeconds(),
    });
  });

  test("a meeting whose live lease names it is refused", async () => {
    const row = strandedRow();
    const world = setup(row);
    jest.mocked(world.deps.readLease).mockResolvedValue({
      meetingId: row.meetingId,
      leaseExpiresAt: world.nowSeconds() + 30,
    } as ActiveMeetingLease);
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "lease_held",
    );
    expect(world.deps.loadRecovery).not.toHaveBeenCalled();
    expect(world.current()).toEqual(row);
  });

  test("a row that carries the lifecycle marker is left to the finisher loop", async () => {
    const world = setup(strandedRow({ lifecycleVersion: 2 }));
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "not_stranded",
    );
    expect(world.deps.loadRecovery).not.toHaveBeenCalled();
  });

  test("a meeting held by another claim is not touched", async () => {
    const held = strandedRow({
      finish: {
        owner: "someone-else",
        expiresAt: Math.floor(NOW_MS / MS_PER_SECOND) + 60,
        attempts: 0,
        phase: "process",
      },
    });
    const world = setup(held);
    await expect(finishStranded(KEY, false, world.deps)).resolves.toBe(
      "not_claimable",
    );
    expect(world.current()).toEqual(held);
  });
});

test("list reports each stranded meeting with what its checkpoint manifest holds", async () => {
  const checkpoint = { revision: 4 } as RecordingCheckpoint;
  const rows = [
    strandedRow({ checkpoint, transcriptS3Key: "synthetic/transcript.json" }),
    strandedRow({ meetingId: "meeting-held" }),
  ];
  const coverage = {
    kind: "verified" as const,
    intervals: [{ sourceId: "user:1", startOffsetMs: 0, durationMs: 4_000 }],
    savedDurationMs: 4_000,
    lastConfirmedCaptureAt: START,
  };
  const listed = await listStranded(
    {
      repository: {
        async *listStranded() {
          yield* rows;
        },
      },
      readManifest: async () => ({
        artifacts: [{ kind: "audio" }, { kind: "audio" }, { kind: "context" }],
        coverage,
      }),
      readLease: async () =>
        ({
          meetingId: "meeting-held",
          leaseExpiresAt: Math.floor(Date.now() / MS_PER_SECOND) + 30,
        }) as ActiveMeetingLease,
    },
    new AbortController().signal,
  );
  expect(listed).toEqual([
    expect.objectContaining({
      status: "processing",
      transcriptSaved: true,
      notesSaved: false,
      leaseHeld: false,
      checkpoint: {
        revision: 4,
        artifacts: { audio: 2, context: 1 },
        savedDurationMs: 4_000,
      },
    }),
    expect.objectContaining({ leaseHeld: true, checkpoint: null }),
  ]);
});

test("the closing message says what happened to the row", () => {
  expect(resultMessage("finished")).toBeUndefined();
  expect(resultMessage("interrupted")).toContain("put back as it was");
  expect(resultMessage("restored")).toContain("put back as it was");
  const pending = resultMessage("delivery_pending");
  expect(pending).not.toContain("put back");
  expect(pending).toContain("notes are saved");
  expect(pending).toContain("--post will post the notes");
});
