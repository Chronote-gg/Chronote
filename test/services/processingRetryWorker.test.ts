/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
import { PROCESSING_RETRY_CLAIM_RENEWAL_MS } from "../../src/constants";
import { processingRetryJobs } from "../../src/metrics";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import { createMockProcessingRetryRepository } from "../../src/repositories/processingRetryRepository";
import { captureEvent } from "../../src/services/analyticsService";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { runNotionMutation } from "../../src/services/notionOperationLifetime";
import { beginShutdown } from "../../src/services/shutdownSignal";
import type { ProcessingRetryRun } from "../../src/services/processingRetryStages";
import {
  createProcessingRetryWorker,
  PROCESSING_RETRY_WORKER_FAILED_LOG,
  type ProcessingRetryWorkerDependencies,
} from "../../src/services/processingRetryWorkerService";
import type { MeetingHistory } from "../../src/types/db";
import type { ProcessingRetryJob } from "../../src/types/meetingProcessingRetry";
import type { MeetingUpdateKey } from "../../src/types/meetingUpdateDelivery";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import {
  regenerationRow,
  runningJob,
} from "../repositories/meetingRegenerationContract";

const REQUESTER = "111111111111111111";
const queuedJob: ProcessingRetryJob = {
  ...runningJob,
  status: "queued",
  requestedBy: REQUESTER,
  countedAttempts: 0,
};
delete queuedJob.claim;
const succeeded: ProcessingRetryRun = {
  kind: "succeeded",
  settingsSource: "current",
  transcriptSource: "existing",
  changes: {
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    notes: "Regenerated",
    summarySentence: "S",
    summaryLabel: "L",
  },
};

let histories: Map<string, MeetingHistory[]>;
let rows: ReturnType<typeof createMockMeetingUpdateDeliveryRepository>;
let deps: ProcessingRetryWorkerDependencies & {
  run: jest.Mock;
  save: jest.Mock;
  available: jest.Mock;
};

const keyAt = (index: number): MeetingUpdateKey => ({
  guildId: key.guildId,
  channelId_timestamp: `${key.channelId_timestamp}-${index}`,
});
function seed(patch: Partial<MeetingHistory> = {}, at = key) {
  const row = { ...regenerationRow(), ...at, processingRetry: queuedJob };
  histories.set(at.guildId, [
    ...(histories.get(at.guildId) ?? []),
    { ...row, ...patch },
  ]);
}
const stored = (at = key) =>
  histories
    .get(at.guildId)!
    .find((row) => row.channelId_timestamp === at.channelId_timestamp)!;

beforeEach(() => {
  histories = new Map();
  rows = createMockMeetingUpdateDeliveryRepository(histories);
  deps = {
    repository: createMockProcessingRetryRepository(histories),
    rows,
    run: jest.fn(async () => succeeded),
    save: jest.fn(
      createMeetingUpdateService({
        repository: rows,
        ready: async () => {},
        syncNotes: jest.fn(),
      }),
    ),
    available: jest.fn(async () => true),
    reader: () => ({ read: jest.fn(), readVerifiedObject: jest.fn() }),
    now: () => now,
    instanceId: () => "instance-a",
    isEligible: () => true,
  };
  jest.mocked(captureEvent).mockClear();
});
afterEach(() => jest.restoreAllMocks());

function expectFailedUnknownWithAlarm(error: jest.SpyInstance) {
  expect(stored().processingRetry).toMatchObject({
    status: "failed",
    failureReason: "unknown",
    countedAttempts: 1,
  });
  expect(error).toHaveBeenCalledWith(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
    expect.anything(),
  );
}

async function pollOnce() {
  const worker = createProcessingRetryWorker(deps);
  await worker.poll();
  await worker.drain();
  return worker;
}

it("idles without querying while the feature is unavailable", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const listDue = jest.spyOn(deps.repository, "listDue");
  deps.available.mockResolvedValue(false);
  const worker = createProcessingRetryWorker(deps);
  await worker.poll();
  await worker.poll();
  expect(listDue).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Processing retry worker idle: flag off or ProcessingRetryDueIndex not ACTIVE",
  );
});

it("an availability read error idles without paging", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const listDue = jest.spyOn(deps.repository, "listDue");
  deps.available.mockRejectedValue(new Error("config unavailable"));
  await pollOnce();
  expect(listDue).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    "Processing retry worker idle: flag off or ProcessingRetryDueIndex not ACTIVE",
  );
});

it("claims a queued job and saves its result with processing_retry provenance", async () => {
  seed();
  await pollOnce();
  expect(deps.save).toHaveBeenCalledWith(
    expect.objectContaining({
      mutation: {
        kind: "regeneration",
        changes: expect.arrayContaining([
          { kind: "notes", notes: "Regenerated" },
        ]),
      },
      actor: { editedBy: REQUESTER },
      notesEdit: {
        expectedNotesVersion: 1,
        source: { type: "processing_retry", jobId: "job-1" },
      },
    }),
  );
  expect(stored()).toMatchObject({
    notes: "Regenerated",
    processingRetry: { status: "succeeded", countedAttempts: 1 },
  });
  expect(stored().processingRetry?.claim).toBeUndefined();
  expect(stored().processingRetryQueue).toBeUndefined();
});

it("never runs more than two jobs at once", async () => {
  for (const index of [1, 2, 3]) seed({}, keyAt(index));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.run.mockImplementation(async () => {
    await held;
    return succeeded;
  });
  const worker = createProcessingRetryWorker(deps);
  await worker.poll();
  await worker.poll();
  expect(deps.run).toHaveBeenCalledTimes(2);
  release();
  await worker.drain();
});

it("a failed stage writes only the failed job and removes it from the queue", async () => {
  seed();
  const before = structuredClone(stored());
  deps.run.mockResolvedValue({
    kind: "failed",
    reason: "stage_failed",
    settingsSource: "current",
    transcriptSource: "existing",
  });
  await pollOnce();
  expect(deps.save).not.toHaveBeenCalled();
  const after = stored();
  expect(after.notes).toEqual(before.notes);
  expect(after.processing).toEqual(before.processing);
  expect(after.contentRevision).toEqual(before.contentRevision);
  expect(after.processingRetry).toMatchObject({
    status: "failed",
    failureReason: "stage_failed",
    countedAttempts: 1,
  });
  expect(after.processingRetryQueue).toBeUndefined();
});

describe("a meeting the finish pipeline gave up on", () => {
  const pipelineFailed: Partial<MeetingHistory> = {
    lifecycleVersion: 2,
    status: "failed",
    capture: {
      kind: "complete",
      startedAt: "2026-10-22T11:00:00.000Z",
      endedAt: "2026-10-22T11:30:00.000Z",
    },
  };

  it("is complete once a retry stores its notes", async () => {
    seed(pipelineFailed);
    await pollOnce();
    expect(stored()).toMatchObject({
      status: "complete",
      notes: "Regenerated",
      processingRetry: { status: "succeeded" },
    });
  });

  it("stays failed when the retry fails", async () => {
    seed(pipelineFailed);
    deps.run.mockResolvedValue({
      kind: "failed",
      reason: "stage_failed",
      settingsSource: "current",
      transcriptSource: "existing",
    });
    await pollOnce();
    expect(stored()).toMatchObject({
      status: "failed",
      processingRetry: { status: "failed" },
    });
  });
});

it("notes edited during the run fail the job with notes_changed and write no content", async () => {
  seed();
  deps.run.mockImplementation(async () => {
    stored().notesVersion = 2;
    return succeeded;
  });
  await pollOnce();
  expect(stored().processingRetry).toMatchObject({
    status: "failed",
    failureReason: "notes_changed",
  });
  expect(stored().notes).toBe("Original synthetic notes");
});

it("notes edited before the run fail the job without running it", async () => {
  seed({ notesVersion: 2 });
  await pollOnce();
  expect(deps.run).not.toHaveBeenCalled();
  expect(stored().processingRetry).toMatchObject({
    status: "failed",
    failureReason: "notes_changed",
    countedAttempts: 1,
  });
});

it("a lost claim stops without any terminal write", async () => {
  seed();
  deps.run.mockImplementation(async () => {
    const row = stored();
    row.processingRetry = {
      ...row.processingRetry!,
      claim: {
        ownerInstanceId: "instance-b",
        claimId: "claim-b",
        leaseExpiresAt: now + 600,
      },
    };
    return succeeded;
  });
  await pollOnce();
  expect(stored().processingRetry).toMatchObject({
    status: "running",
    claim: { ownerInstanceId: "instance-b" },
  });
  expect(stored().notes).toBe("Original synthetic notes");
});

it("re-claims a running job whose lease lapsed", async () => {
  seed({
    processingRetry: {
      ...runningJob,
      requestedBy: REQUESTER,
      claim: {
        ownerInstanceId: "instance-b",
        claimId: "claim-b",
        leaseExpiresAt: now - 1,
      },
    },
    processingRetryDueAt: now - 1,
  });
  await pollOnce();
  expect(deps.run).toHaveBeenCalledTimes(1);
  expect(stored().processingRetry).toMatchObject({
    status: "succeeded",
    countedAttempts: 1,
  });
});

it("captures the completed event and counts the outcome", async () => {
  const inc = jest.spyOn(processingRetryJobs, "inc");
  seed();
  await pollOnce();
  expect(captureEvent).toHaveBeenCalledWith(
    "meeting_processing_retry_completed",
    {
      userId: REQUESTER,
      guildId: key.guildId,
      properties: expect.objectContaining({
        outcome: "succeeded",
        stages: ["notes", "summary"],
        counted_attempts: 1,
        transcript_source: "existing",
        settings_source: "current",
      }),
    },
  );
  expect(inc).toHaveBeenCalledWith({ outcome: "succeeded", reason: "none" });
});

it("an unexpected error fails the job as unknown and logs the alarm line", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  deps.run.mockRejectedValue(new Error("provider exploded"));
  await pollOnce();
  expectFailedUnknownWithAlarm(error);
});

it("a lost lease renewal aborts the job's signal and no later write is attempted", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "queueMicrotask"] });
  try {
    seed();
    const renew = jest.spyOn(deps.repository, "renew").mockResolvedValue(false);
    const fail = jest.spyOn(deps.repository, "fail");
    let signal: AbortSignal | undefined;
    deps.run.mockImplementation(
      (input: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = input.signal;
          input.signal.addEventListener("abort", () =>
            reject(input.signal.reason),
          );
        }),
    );
    const worker = createProcessingRetryWorker(deps);
    await worker.poll();
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(PROCESSING_RETRY_CLAIM_RENEWAL_MS);
    await worker.drain();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(deps.save).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(stored().processingRetry).toMatchObject({ status: "running" });
  } finally {
    jest.useRealTimers();
  }
});

it("two workers claim the same job: exactly one runs it", async () => {
  seed();
  const other = { ...deps, instanceId: () => "instance-b" };
  const first = createProcessingRetryWorker(deps);
  const second = createProcessingRetryWorker(other);
  const claim = jest.spyOn(deps.repository, "claim");
  await Promise.all([first.poll(), second.poll()]);
  await Promise.all([first.drain(), second.drain()]);
  expect(claim).toHaveBeenCalledTimes(2);
  expect(deps.run).toHaveBeenCalledTimes(1);
  expect(stored().processingRetry).toMatchObject({
    status: "succeeded",
    countedAttempts: 1,
  });
});

it("runs a job with no deployment control record present", async () => {
  seed();
  await pollOnce();
  expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
});

it("a save that committed but reported a conflict counts as saved", async () => {
  seed();
  const save = deps.save.getMockImplementation()!;
  deps.save.mockImplementation(async (input) => {
    await save(input);
    return { kind: "conflict" };
  });
  await pollOnce();
  expect(deps.save).toHaveBeenCalledTimes(1);
  expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
});

it("a save that keeps conflicting under a held claim fails unknown after three attempts", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  deps.save.mockResolvedValue({ kind: "conflict" });
  await pollOnce();
  expect(deps.save).toHaveBeenCalledTimes(3);
  expectFailedUnknownWithAlarm(error);
});

it("a throwing claim is logged and the key skipped", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  jest
    .spyOn(deps.repository, "claim")
    .mockRejectedValue(new Error("unknown outcome"));
  await pollOnce();
  expect(deps.run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
    expect.anything(),
  );
});

it("a save that commits and then throws still counts as saved", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  const save = deps.save.getMockImplementation()!;
  deps.save.mockImplementation(async (input) => {
    await save(input);
    throw new Error("response lost");
  });
  await pollOnce();
  expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
  expect(captureEvent).toHaveBeenCalledWith(
    "meeting_processing_retry_completed",
    expect.objectContaining({
      properties: expect.objectContaining({ outcome: "succeeded" }),
    }),
  );
});

const generatedName: ProcessingRetryRun = {
  ...succeeded,
  changes: { ...succeeded.changes, meetingName: "Generated name" },
};
const renameService = () =>
  createMeetingUpdateService({
    repository: rows,
    ready: async () => {},
    syncNotes: jest.fn(),
  });
const userRename = () =>
  renameService()({
    key,
    mutation: { kind: "rename", meetingName: "User name" },
    actor: { editedBy: REQUESTER },
  });

function expectUserNameKeptWithRegeneratedNotes() {
  expect(stored()).toMatchObject({
    meetingName: "User name",
    notes: "Regenerated",
    processingRetry: { status: "succeeded" },
  });
}

it("names a meeting that is still unnamed when the result is saved", async () => {
  seed({ meetingName: undefined });
  deps.run.mockResolvedValue(generatedName);
  await pollOnce();
  expect(stored()).toMatchObject({
    meetingName: "Generated name",
    notes: "Regenerated",
  });
});

it("a rename during the run keeps the user's name and still saves the regenerated notes", async () => {
  seed({ meetingName: undefined });
  deps.run.mockImplementation(async () => {
    await userRename();
    return generatedName;
  });
  await pollOnce();
  expectUserNameKeptWithRegeneratedNotes();
});

it("a rename that lands between the save's read and its write cannot be overwritten", async () => {
  seed({ meetingName: undefined });
  deps.run.mockResolvedValue(generatedName);
  let raced = false;
  deps.save.mockImplementation(
    createMeetingUpdateService({
      repository: {
        ...rows,
        async updateContentAndDelivery(input, signal) {
          if (!raced) {
            raced = true;
            await userRename();
          }
          return rows.updateContentAndDelivery(input, signal);
        },
      },
      ready: async () => {},
      syncNotes: jest.fn(),
    }),
  );
  await pollOnce();
  expect(deps.save).toHaveBeenCalledTimes(2);
  expectUserNameKeptWithRegeneratedNotes();
});

describe("Notion auto-sync after the save", () => {
  const saveWithSync = (sync: (signal?: AbortSignal) => Promise<unknown>) =>
    deps.save.mockImplementation(
      createMeetingUpdateService({
        repository: rows,
        ready: async () => {},
        syncNotes: jest.fn(async (_meeting, signal) => {
          await sync(signal);
        }),
      }),
    );

  it("runs under the job's signal, so the mutation is admitted", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    seed();
    const exported = jest.fn(async () => "exported");
    saveWithSync((signal) => runNotionMutation(signal, exported));
    await pollOnce();
    expect(deps.save.mock.calls[0][0].signal).toBe(
      deps.run.mock.calls[0][0].signal,
    );
    expect(exported).toHaveBeenCalled();
    expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
    expect(error).not.toHaveBeenCalled();
  });

  it("an uncertain Notion mutation leaves the job succeeded and does not page", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    seed();
    saveWithSync((signal) =>
      runNotionMutation(signal, async () => {
        throw new Error("socket hang up");
      }),
    );
    await pollOnce();
    expect(stored()).toMatchObject({
      notes: "Regenerated",
      processingRetry: { status: "succeeded" },
    });
    expect(error).not.toHaveBeenCalledWith(
      PROCESSING_RETRY_WORKER_FAILED_LOG,
      expect.anything(),
    );
  });
});

// Shutdown is process-wide and cannot be undone, so this runs last.
it("a worker shut down before it claims anything logs no failure line", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  jest.spyOn(deps.rows, "getStrong").mockImplementation(async () => {
    beginShutdown();
    throw new Error("aborted");
  });
  await pollOnce();
  expect(error).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
  expect(stored().processingRetry).toMatchObject({ status: "queued" });
});
