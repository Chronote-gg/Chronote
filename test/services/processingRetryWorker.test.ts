/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: jest.fn(),
}));
import { PROCESSING_RETRY_CLAIM_SECONDS } from "../../src/constants";
import { processingRetryJobs } from "../../src/metrics";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import { createMockProcessingRetryRepository } from "../../src/repositories/processingRetryRepository";
import { captureEvent } from "../../src/services/analyticsService";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { getRuntimeAdmissionContext } from "../../src/services/runtimeLifecycleService";
import {
  beginRuntimeWorkClaim,
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
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
import { authority } from "../repositories/meetingUpdateDeliveryContract";
import {
  regenerationRow,
  runningJob,
} from "../repositories/meetingRegenerationContract";

type RetryWork = ReturnType<ProcessingRetryWorkerDependencies["begin"]>;
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
let works: (RetryWork & { acknowledgeTerminal: jest.Mock })[];
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

function stubWork() {
  const controller = new AbortController();
  const work = {
    signal: controller.signal,
    trackPromise: <T>(run: () => Promise<T>) => run(),
    trackEffect: <T>(run: () => Promise<T>) => {
      controller.signal.throwIfAborted();
      return run();
    },
    authority: async () => authority,
    recordClaim: jest.fn(),
    claimed: jest.fn(),
    acknowledgeTerminal: jest.fn(),
    acknowledgeReadOnlyRecoveryPoll: jest.fn(),
    fence: jest.fn(() => controller.abort()),
    settle: jest.fn(async () => {}),
  };
  works.push(work);
  return work;
}

beforeEach(() => {
  histories = new Map();
  works = [];
  const rows = createMockMeetingUpdateDeliveryRepository(histories, () => true);
  deps = {
    repository: createMockProcessingRetryRepository(histories, () => true),
    rows,
    begin: jest.fn(() => stubWork()),
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
  };
  jest.mocked(captureEvent).mockClear();
});
afterEach(() => jest.restoreAllMocks());

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
  expect(works[0].acknowledgeTerminal).toHaveBeenCalled();
  expect(stored()).toMatchObject({
    notes: "Regenerated",
    processingRetry: { status: "succeeded", countedAttempts: 1 },
  });
  expect(stored().processingRetry?.claim).toBeUndefined();
  expect(stored().processingRetryQueue).toBeUndefined();
});

it("never runs more than two jobs at once", async () => {
  for (const index of [1, 2, 3]) seed({}, keyAt(index));
  deps.run.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  const worker = createProcessingRetryWorker(deps);
  await worker.poll();
  await worker.poll();
  expect(deps.run).toHaveBeenCalledTimes(2);
  for (const work of works) work.fence();
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
  expect(works[0].acknowledgeTerminal).toHaveBeenCalled();
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
  expect(works[0].acknowledgeTerminal).not.toHaveBeenCalled();
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
  expect(stored().processingRetry).toMatchObject({
    status: "failed",
    failureReason: "unknown",
    countedAttempts: 1,
  });
  expect(error).toHaveBeenCalledWith(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
    expect.anything(),
  );
});

it("a fenced run leaves the job running for its lease to lapse", async () => {
  seed();
  deps.run.mockImplementation(async () => {
    works[0].fence();
    throw new Error("aborted");
  });
  await pollOnce();
  expect(stored().processingRetry).toMatchObject({ status: "running" });
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
  expect(works[0].acknowledgeTerminal).toHaveBeenCalled();
});

it("a save that keeps conflicting under a held claim fails unknown after three attempts", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  deps.save.mockResolvedValue({ kind: "conflict" });
  await pollOnce();
  expect(deps.save).toHaveBeenCalledTimes(3);
  expect(stored().processingRetry).toMatchObject({
    status: "failed",
    failureReason: "unknown",
    countedAttempts: 1,
  });
  expect(error).toHaveBeenCalledWith(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
    expect.anything(),
  );
});

it("a throwing claim is logged and the key skipped", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  jest
    .spyOn(deps.repository, "claim")
    .mockRejectedValue(new Error("unknown outcome"));
  await pollOnce();
  expect(deps.run).not.toHaveBeenCalled();
  const [submitted] = jest.mocked(deps.repository.claim).mock.calls[0];
  expect(works[0].recordClaim).toHaveBeenCalledWith({
    claimId: submitted.claimId,
    instanceId: "instance-a",
    expiresAt: now + 300,
  });
  expect(works[0].fence).toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
    expect.anything(),
  );
});

it("a refused work admission warns once without paging", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  seed();
  deps.begin = jest.fn(() => {
    throw new Error("Runtime is not accepting work");
  });
  const worker = createProcessingRetryWorker(deps);
  await worker.poll();
  await worker.poll();
  expect(deps.begin).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});

it("claims nothing without serving authority", async () => {
  seed();
  deps.begin = jest.fn(() => ({
    ...stubWork(),
    authority: async () => ({
      kind: "session" as const,
      ownership: {
        guildId: key.guildId,
        meetingId: "synthetic-meeting",
        ownerInstanceId: "instance-a",
        executionVersion: 1,
        voiceOperationAttemptId: "attempt-1",
      },
      now,
    }),
  }));
  await pollOnce();
  expect(deps.run).not.toHaveBeenCalled();
  expect(stored().processingRetry).toMatchObject({ status: "queued" });
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
  expect(works[0].acknowledgeTerminal).toHaveBeenCalled();
  expect(captureEvent).toHaveBeenCalledWith(
    "meeting_processing_retry_completed",
    expect.objectContaining({
      properties: expect.objectContaining({ outcome: "succeeded" }),
    }),
  );
});

describe("with real runtime work admission", () => {
  beforeEach(() => {
    jest
      .mocked(getRuntimeAdmissionContext)
      .mockResolvedValue(authority.context);
    deps.begin = beginRuntimeWorkClaim;
  });
  afterEach(() => {
    fenceRuntimeWorkAdmissions();
  });

  it("releases a work handle fenced before its claim was sent, without paging", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    seed();
    jest.spyOn(deps.rows, "getStrong").mockImplementation(async () => {
      fenceRuntimeWorkAdmissions();
      throw new Error("aborted");
    });
    await pollOnce();
    expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(stored().processingRetry).toMatchObject({ status: "queued" });
  });

  it("skips a key without paging when admission closes before the claim", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    seed();
    jest
      .mocked(getRuntimeAdmissionContext)
      .mockRejectedValue(new Error("Runtime is not serving"));
    await pollOnce();
    expect(error).not.toHaveBeenCalled();
    expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
    expect(stored().processingRetry).toMatchObject({ status: "queued" });
  });

  it("releases the work handle after a success", async () => {
    seed();
    await pollOnce();
    expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
    expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
  });

  it("releases the work handle after a failure", async () => {
    seed();
    deps.run.mockResolvedValue({
      kind: "failed",
      reason: "stage_failed",
      settingsSource: "current",
      transcriptSource: "existing",
    });
    await pollOnce();
    expect(stored().processingRetry).toMatchObject({ status: "failed" });
    expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
  });

  // Leaves its fenced handle registered, so it runs last.
  it("claims a key again after its lease lapses while a fenced handle stays registered", async () => {
    let clock = now;
    deps.now = () => clock;
    seed();
    deps.run.mockImplementationOnce(async () => {
      fenceRuntimeWorkAdmissions();
      throw new Error("lease lost");
    });
    await pollOnce();
    expect(stored().processingRetry).toMatchObject({ status: "running" });
    clock += PROCESSING_RETRY_CLAIM_SECONDS + 1;
    await pollOnce();
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(stored().processingRetry).toMatchObject({ status: "succeeded" });
    expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([
      expect.objectContaining({ fenced: true, stage: "unresolved" }),
    ]);
  });
});
