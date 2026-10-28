/** @jest-environment node */
import { UnresolvedNotionMutation } from "../notionOperationLifetime";
import { maybeAutoExportCompletedMeeting } from "../notionAutomationService";
import { jest } from "@jest/globals";
import ffmpeg from "fluent-ffmpeg";
import { completedTextResponse } from "../../testSupport/openaiResponse";
import { getModelChoice } from "../modelFactory";
import {
  buildJob,
  buildDesktopJob,
  buildSegment,
} from "../../testSupport/personalMediaUploadFixtures";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../types/db";
import {
  getMeetingHistoryService,
  writeMeetingHistoryService,
} from "../meetingHistoryService";
import {
  listPersonalRecordingUploadSegments,
  markPersonalRecordingUploadSegmentProcessed,
  markPersonalRecordingUploadSegmentFailed,
  markPersonalRecordingUploadSegmentProcessing,
  updateClaimedPersonalMediaUploadJobProgress,
  updateClaimedPersonalMediaUploadJobRecord,
} from "../personalMediaUploadService";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "../personalMediaUploadProcessingService";
import {
  downloadObjectToFile,
  fetchJsonFromS3,
  uploadObjectToS3,
} from "../storageService";
import {
  PERSONAL_UPLOAD_TRANSCRIPTION_CHUNK_SECONDS,
  TRANSCRIPTION_FAILURE_PLACEHOLDER,
} from "../../constants";
import type { MeetingSummaries } from "../meetingSummaryService";
import { resolveMeetingNameFromSummary } from "../meetingNameService";
import { recordPersonalUploadTerminal } from "../../observability/personalUploadTrace";
import { writeMeetingUserIndexForMeetingService } from "../meetingUserIndexService";
import { processPersonalMediaUploadJob } from "../personalMediaUploadWorkerService";
import {
  createRuntimeLifecycle,
  installRuntimeLifecycle,
} from "../runtimeLifecycleService";
import { createRuntimeProtectionService } from "../runtimeProtectionService";
import { getRuntimeInstanceId } from "../runtimeInstanceService";
import { getDeploymentControlRepository } from "../../db";
import { getRuntimeWorkAdmissionCheckpoints } from "../runtimeWorkAdmissionService";
import { PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS } from "../../constants";
import type { PersonalMediaUploadRepository } from "../../repositories/personalMediaUploadRepository";
import { getMockStore } from "../../repositories/mockStore";

let mockWorkerJob: PersonalMediaUploadJobRecord | undefined;
let mockCanonicalCompletion = false;
const mockWorkerClaim = jest.fn<PersonalMediaUploadRepository["claim"]>();
const mockWorkerRenew = jest.fn<PersonalMediaUploadRepository["renewClaim"]>(
  async () => mockWorkerJob?.status === "processing",
);

jest.mock("../../observability/personalUploadTrace", () => ({
  withPersonalUploadProcessingTrace: (
    _job: unknown,
    run: () => Promise<void>,
  ) => run(),
  recordPersonalUploadTerminal: jest.fn(),
}));

const mockUploadedObjects = new Map<string, string | Buffer>();
const mockConcatLists: string[] = [];
let mockHoldConversion = false;
let mockConversionEnd: (() => void) | undefined;
const mockConversionKill = jest.fn();
const mockTranscribe = jest.fn<
  (
    request?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<{ text: string }>
>(async () => ({ text: "segment transcript" }));
const mockCreateResponse = jest.fn<
  () => Promise<ReturnType<typeof completedTextResponse>>
>(async () => completedTextResponse("Generated notes"));
const mockGenerateSummaries = jest.fn<() => Promise<MeetingSummaries>>(
  async () => ({
    summarySentence: "Summary",
    summaryLabel: "Label",
  }),
);

jest.mock("fluent-ffmpeg", () => {
  const { createPersonalUploadFfmpegFake } = jest.requireActual<
    typeof import("../testFixtures/personalMediaUploadFfmpeg.fixture")
  >("../testFixtures/personalMediaUploadFfmpeg.fixture");
  return createPersonalUploadFfmpegFake({
    getConcatLists: () => mockConcatLists,
    isHeld: () => mockHoldConversion,
    captureEnd: (handler) => {
      mockConversionEnd = handler;
    },
    getKill: () => mockConversionKill,
  });
});

jest.mock("../meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(async () => undefined),
  writeMeetingHistoryService: jest.fn(async () => undefined),
}));

jest.mock("../meetingUserIndexService", () => ({
  writeMeetingUserIndexForMeetingService: jest.fn(async () => undefined),
}));
jest.mock("../../repositories/personalMediaUploadRepository", () => ({
  getPersonalMediaUploadRepository: () => ({
    claim: mockWorkerClaim,
    renewClaim: mockWorkerRenew,
    get: async () => mockWorkerJob,
    writeHistory: async (
      history: import("../../types/db").MeetingHistory,
      claim: import("../../types/db").PersonalMediaClaim,
      terminal?: PersonalMediaUploadJobRecord,
    ) => {
      await writeMeetingHistoryService(history);
      if (terminal) {
        if (mockWorkerJob) mockWorkerJob = terminal;
        const saved = await updateClaimedPersonalMediaUploadJobRecord(
          terminal,
          claim.instanceId,
        );
        if (!saved) return { kind: "stale" as const };
      }
      return {
        kind: "committed" as const,
        history:
          mockCanonicalCompletion && terminal?.status === "complete"
            ? {
                ...history,
                notes: "Manual canonical notes",
                notesVersion: 2,
                notesLastEditedBy: "synthetic-editor",
                notesHistory: [
                  {
                    version: 2,
                    notes: "Manual canonical notes",
                    editedBy: "synthetic-editor",
                    editedAt: history.timestamp,
                  },
                ],
                recovery: {
                  disposition: "needs_reconciliation",
                  stage: "delivery",
                  reason: "delivery_uncertain",
                },
              }
            : history,
      };
    },
  }),
}));

jest.mock("../personalMediaUploadService", () => ({
  listPersonalRecordingUploadSegments: jest.fn(async () => []),
  markPersonalRecordingUploadSegmentFailed: jest.fn(
    async (segment: unknown) => segment,
  ),
  markPersonalRecordingUploadSegmentProcessed: jest.fn(
    async (segment: unknown) => segment,
  ),
  markPersonalRecordingUploadSegmentProcessing: jest.fn(
    async (segment: unknown) => segment,
  ),
  markPersonalRecordingUploadSegmentsFailed: jest.fn(async () => undefined),
  updateClaimedPersonalMediaUploadJobProgress: jest.fn(async () => false),
  updateClaimedPersonalMediaUploadJobRecord: jest.fn(async () => false),
}));

jest.mock("../storageService", () => ({
  downloadObjectToFile: jest.fn(
    async (_key: string, destinationPath: string) => {
      const fs = await import("node:fs/promises");
      await fs.writeFile(destinationPath, Buffer.from("source"));
      return true;
    },
  ),
  fetchJsonFromS3: jest.fn(async (key: string) => {
    const raw = mockUploadedObjects.get(key);
    return typeof raw === "string" ? JSON.parse(raw) : undefined;
  }),
  uploadObjectToS3: jest.fn(async (key: string, body: string | Buffer) => {
    mockUploadedObjects.set(key, body);
    return key;
  }),
}));

jest.mock("../tempFileService", () => ({
  ensureTempBaseDir: jest.fn(async () => "tmp/personal-upload-tests"),
}));

jest.mock("../openaiClient", () => ({
  createOpenAIClient: jest.fn(() => ({
    audio: { transcriptions: { create: mockTranscribe } },
    responses: { create: mockCreateResponse },
  })),
}));

jest.mock("../modelFactory", () => ({
  getModelChoice: jest.fn(() => ({ model: "mock-model" })),
}));

jest.mock("../openaiModelParams", () => ({
  resolveChatParamsForRole: jest.fn(() => ({})),
}));

jest.mock("../langfusePromptService", () => ({
  getLangfuseChatPrompt: jest.fn(async () => ({
    messages: [{ role: "user", content: "notes" }],
    langfusePrompt: undefined,
  })),
}));

jest.mock("../meetingSummaryService", () => ({
  generateMeetingSummaries: () => mockGenerateSummaries(),
}));

jest.mock("../meetingNameService", () => ({
  resolveMeetingNameFromSummary: jest.fn(async () => "Meeting name"),
}));

jest.mock("../notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(async () => undefined),
}));

let recordingSegments: PersonalRecordingSegmentRecord[] = [];

const replaceSegment = (next: PersonalRecordingSegmentRecord) => {
  recordingSegments = recordingSegments.map((segment) =>
    segment.segmentKey === next.segmentKey ? next : segment,
  );
  return next;
};

function heldOperation() {
  let release!: () => void;
  let enter!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    wait: async () => {
      enter();
      await waiting;
    },
  };
}

function expectEmptyUploadWithoutNotes() {
  expect(mockCreateResponse).not.toHaveBeenCalled();
  expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
    expect.objectContaining({
      notes: "",
      processing: {
        transcription: "empty",
        notes: "skipped",
        summary: "skipped",
      },
    }),
  );
}

describe("personalMediaUploadProcessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getModelChoice).mockReturnValue({
      provider: "openai",
      model: "mock-model",
    });
    mockUploadedObjects.clear();
    mockConcatLists.length = 0;
    recordingSegments = [];
    mockWorkerJob = undefined;
    mockCanonicalCompletion = false;
    mockTranscribe.mockResolvedValue({ text: "segment transcript" });
    mockCreateResponse.mockResolvedValue(
      completedTextResponse("Generated notes"),
    );
    mockGenerateSummaries.mockResolvedValue({
      summarySentence: "Summary",
      summaryLabel: "Label",
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(undefined);
    jest
      .mocked(listPersonalRecordingUploadSegments)
      .mockImplementation(async () => recordingSegments);
    jest
      .mocked(markPersonalRecordingUploadSegmentProcessing)
      .mockImplementation(async (segment) =>
        replaceSegment({ ...segment, status: "processing" }),
      );
    jest
      .mocked(markPersonalRecordingUploadSegmentProcessed)
      .mockImplementation(async (segment, options) =>
        replaceSegment({
          ...segment,
          status: "processed",
          transcriptS3Key: options?.transcriptS3Key,
        }),
      );
    jest
      .mocked(markPersonalRecordingUploadSegmentFailed)
      .mockImplementation(async (segment, error) =>
        replaceSegment({
          ...segment,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "failed",
        }),
      );
    jest
      .mocked(updateClaimedPersonalMediaUploadJobProgress)
      .mockResolvedValue(true);
    jest
      .mocked(updateClaimedPersonalMediaUploadJobRecord)
      .mockResolvedValue(true);
  });

  it("first personal export consumes acknowledged canonical content and original completion authority", async () => {
    mockCanonicalCompletion = true;
    await processPersonalMediaUpload(buildJob(), "instance-1");
    expect(maybeAutoExportCompletedMeeting).toHaveBeenCalledTimes(1);
    const exported = jest.mocked(maybeAutoExportCompletedMeeting).mock
      .calls[0][0];
    expect(exported).toMatchObject({
      notes: "Manual canonical notes",
      notesVersion: 2,
      notesLastEditedBy: "synthetic-editor",
      notesHistory: [
        expect.objectContaining({
          version: 2,
          notes: "Manual canonical notes",
        }),
      ],
    });
    expect(exported.recovery).toBeUndefined();
  });

  describe.each(["ordinary", "desktop"])("%s finalization", (origin) => {
    const jobForOrigin = () =>
      origin === "desktop" ? buildDesktopJob() : buildJob();
    it.each([{ summarySentence: "Summary" }, { summaryLabel: "Label" }])(
      "accepts a one-field summary: %j",
      async (summaries) => {
        recordingSegments = [buildSegment(0)];
        mockGenerateSummaries.mockResolvedValueOnce(summaries);
        await processPersonalMediaUpload(
          { ...jobForOrigin(), attempts: 3 },
          "instance-1",
        );
        expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
          expect.objectContaining({
            processing: {
              transcription: "ready",
              notes: "generated",
              summary: "generated",
            },
          }),
        );
      },
    );

    it("avoids caching unique personal recording inputs on capable notes models", async () => {
      recordingSegments = [buildSegment(0)];
      jest.mocked(getModelChoice).mockReturnValue({
        provider: "openai",
        model: "gpt-6.1-sol",
      });

      const controller = new AbortController();
      await processPersonalMediaUpload(
        { ...jobForOrigin(), attempts: 3 },
        "instance-1",
        controller.signal,
      );

      expect(mockCreateResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-6.1-sol",
          input: [{ role: "user", content: "notes" }],
          prompt_cache_options: { mode: "explicit", ttl: "30m" },
        }),
        { signal: controller.signal },
      );
    });

    it("does not blame transcription for a source download failure", async () => {
      recordingSegments = [buildSegment(0)];
      jest
        .mocked(downloadObjectToFile)
        .mockRejectedValueOnce(new Error("download failed"));
      await processPersonalMediaUpload(
        { ...jobForOrigin(), attempts: 3 },
        "instance-1",
      );
      expect(mockTranscribe).not.toHaveBeenCalled();
      expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
        expect.objectContaining({
          processing: { notes: "skipped", summary: "skipped" },
        }),
      );
      expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
        "upload-1",
        expect.objectContaining({
          jobStatus: "failed",
          processing: { notes: "skipped", summary: "skipped" },
        }),
      );
    });
    beforeEach(() => {
      recordingSegments = [buildSegment(0)];
    });

    it.each(["   ", "", "<@123456789012345678>"])(
      "requeues then fails blank sanitized notes (%s)",
      async (content) => {
        mockCreateResponse.mockResolvedValue(completedTextResponse(content));
        await processPersonalMediaUpload(
          { ...jobForOrigin(), attempts: 2 },
          "instance-1",
        );
        expect(
          updateClaimedPersonalMediaUploadJobRecord,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "queued", retryable: true }),
          "instance-1",
        );
        expect(writeMeetingHistoryService).not.toHaveBeenCalled();
        expect(recordPersonalUploadTerminal).not.toHaveBeenCalled();
        await processPersonalMediaUpload(
          { ...jobForOrigin(), attempts: 3 },
          "instance-1",
        );
        const processing = {
          transcription: "ready",
          notes: "failed",
          summary: "skipped",
        };
        expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "complete", processing }),
        );
        expect(
          updateClaimedPersonalMediaUploadJobRecord,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "failed", retryable: false }),
          "instance-1",
        );
        expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
          "upload-1",
          expect.objectContaining({
            processing,
            failedChunks: 0,
            jobStatus: "failed",
          }),
        );
        expect(mockGenerateSummaries).not.toHaveBeenCalled();
      },
    );

    it.each([2, 3])(
      "preserves generated outcomes when naming fails on attempt %s",
      async (attempts) => {
        jest
          .mocked(resolveMeetingNameFromSummary)
          .mockRejectedValueOnce(new Error("database unavailable"));
        await processPersonalMediaUpload(
          { ...jobForOrigin(), attempts },
          "instance-1",
        );
        expect(
          updateClaimedPersonalMediaUploadJobRecord,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: attempts === 3 ? "failed" : "queued",
            retryable: attempts < 3,
          }),
          "instance-1",
        );
        if (attempts < 3) {
          expect(writeMeetingHistoryService).not.toHaveBeenCalled();
          expect(recordPersonalUploadTerminal).not.toHaveBeenCalled();
        } else {
          const processing = {
            transcription: "ready",
            notes: "generated",
            summary: "generated",
          };
          expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: "complete", processing }),
          );
          expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
            "upload-1",
            expect.objectContaining({
              processing,
              failedChunks: 0,
              jobStatus: "failed",
            }),
          );
        }
      },
    );
  });

  it("fences initialization after a held index while the durable claim remains valid", async () => {
    const held = heldOperation();
    jest
      .mocked(writeMeetingUserIndexForMeetingService)
      .mockImplementationOnce(held.wait);
    const controller = new AbortController();
    const initialization = createPersonalMediaProcessingMeeting(
      buildJob(),
      "instance-1",
      controller.signal,
    );
    await held.started;
    controller.abort(new Error("synthetic fence"));
    held.release();
    await expect(initialization).rejects.toThrow("synthetic fence");
    expect(updateClaimedPersonalMediaUploadJobRecord).not.toHaveBeenCalled();
  });

  it.each(["download", "list"] as const)(
    "fences canonical writes after a held %s with a valid claim",
    async (boundary) => {
      recordingSegments = [buildSegment(0)];
      const held = heldOperation();
      if (boundary === "download") {
        const download = jest
          .mocked(downloadObjectToFile)
          .getMockImplementation()!;
        jest
          .mocked(downloadObjectToFile)
          .mockImplementationOnce(async (...args) => {
            await held.wait();
            return download(...args);
          });
      } else {
        jest
          .mocked(listPersonalRecordingUploadSegments)
          .mockImplementationOnce(async () => recordingSegments)
          .mockImplementationOnce(async () => {
            await held.wait();
            return recordingSegments;
          });
      }
      const controller = new AbortController();
      const processing = processPersonalMediaUpload(
        buildDesktopJob(),
        "instance-1",
        controller.signal,
      );
      await held.started;
      controller.abort(new Error("synthetic fence"));
      held.release();
      await expect(processing).rejects.toThrow("synthetic fence");
      expect(
        markPersonalRecordingUploadSegmentProcessing,
      ).toHaveBeenCalledTimes(boundary === "download" ? 0 : 1);
      expect(
        updateClaimedPersonalMediaUploadJobProgress,
      ).not.toHaveBeenCalled();
      expect(updateClaimedPersonalMediaUploadJobRecord).not.toHaveBeenCalled();
      expect(writeMeetingHistoryService).not.toHaveBeenCalled();
    },
  );

  it("keeps held indexing counted and retains an unknown subsequent automatic export", async () => {
    jest.useFakeTimers({ now: 100_000 });
    getMockStore().deploymentControlRecords.clear();
    const identity = {
      kind: "local" as const,
      instanceId: getRuntimeInstanceId(),
      localId: "terminal-index-fixture",
      protocolVersion: 1 as const,
    };
    const repository = getDeploymentControlRepository();
    await repository.initializeControl({
      pk: "ENV",
      sk: "CONTROL",
      recordType: "control",
      runtimeEnvironment: "local",
      protocolVersion: 1,
      coordinatorToken: "fixture",
      coordinatorEpoch: 1,
      coordinatorExpiresAt: 1000,
      servingGeneration: 0,
      servingMembers: {},
    });
    const lifecycle = createRuntimeLifecycle({
      identity,
      repository,
      protection: createRuntimeProtectionService({
        identity,
        onUnsafe: jest.fn(() => undefined),
      }),
      probeReadiness: async () => ({
        gatewayReady: true,
        cacheReady: true,
        dependenciesReady: true,
      }),
      checkpointAndFence: jest.fn(async () => undefined),
    });
    installRuntimeLifecycle(lifecycle);
    await lifecycle.start();
    await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "fixture",
      coordinatorEpoch: 1,
      expectedServingGeneration: 0,
      expectedServingMembers: [],
      candidate: identity,
      proposedGeneration: 1,
      now: 100,
    });
    await lifecycle.getRuntimeAdmissionContext();
    mockWorkerClaim.mockImplementationOnce(async (input) => {
      mockWorkerJob = {
        ...buildJob(),
        status: "processing",
        processingClaimId: input.claimId,
        processingOwnerInstanceId: input.instanceId,
      };
      return mockWorkerJob;
    });
    const held = heldOperation();
    const provider = heldOperation();
    let finishRenewal!: (value: boolean) => void;
    mockTranscribe.mockImplementationOnce(async () => {
      await provider.wait();
      return { text: "synthetic transcript" };
    });
    mockWorkerRenew.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRenewal = resolve;
        }),
    );
    jest
      .mocked(writeMeetingUserIndexForMeetingService)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(held.wait);
    try {
      const processing = processPersonalMediaUploadJob(buildJob());
      await provider.started;
      await jest.advanceTimersByTimeAsync(
        PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS + 1,
      );
      provider.release();
      await held.started;
      expect(mockWorkerJob?.status).toBe("complete");
      expect(lifecycle.getWorkCounts()).toMatchObject({
        personal_processing: 0,
        ancillary_delivery: 1,
      });
      await jest.advanceTimersByTimeAsync(
        PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS + 1,
      );
      finishRenewal(false);
      await Promise.resolve();
      expect(mockWorkerRenew).toHaveBeenCalledTimes(1);
      expect(getRuntimeWorkAdmissionCheckpoints()).toMatchObject([
        { domain: "ancillary", fenced: false },
      ]);
      held.release();
      provider.release();
      await processing;
      expect(lifecycle.getWorkCounts().ancillary_delivery).toBe(0);
      expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(0);
      jest
        .mocked(maybeAutoExportCompletedMeeting)
        .mockRejectedValueOnce(
          new UnresolvedNotionMutation(new Error("synthetic lost response")),
        );
      mockWorkerClaim.mockImplementationOnce(async (input) => {
        mockWorkerJob = {
          ...buildJob(),
          status: "processing",
          processingClaimId: input.claimId,
          processingOwnerInstanceId: input.instanceId,
        };
        return mockWorkerJob;
      });
      await processPersonalMediaUploadJob(buildJob());
      expect(lifecycle.getWorkCounts().ancillary_delivery).toBe(1);
      expect(getRuntimeWorkAdmissionCheckpoints()).toMatchObject([
        {
          fenced: true,
          localSettled: true,
          terminalAcknowledged: { claimId: mockWorkerJob!.processingClaimId },
        },
      ]);
    } finally {
      held.release();
      lifecycle.stop();
      jest.useRealTimers();
    }
  });

  it("acknowledges terminal disposition before awaiting ancillary indexing", async () => {
    const held = heldOperation();
    jest
      .mocked(writeMeetingUserIndexForMeetingService)
      .mockImplementationOnce(held.wait);
    const durable = jest.fn();
    const processing = processPersonalMediaUpload(
      buildJob(),
      "instance-1",
      undefined,
      durable,
    );
    await held.started;
    const acknowledgedWhileHeld = durable.mock.calls.length;
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete" }),
      "instance-1",
    );
    held.release();
    await processing;
    expect(acknowledgedWhileHeld).toBe(1);
    expect(durable).toHaveBeenCalledTimes(1);
  });

  it("personal conversion cancellation retains the actual encoder until its terminal event", async () => {
    mockHoldConversion = true;
    const controller = new AbortController();
    let settled = false;
    const processing = processPersonalMediaUpload(
      buildJob(),
      "instance-1",
      controller.signal,
    );
    const outcome = processing.then(
      () => {
        settled = true;
        return "complete";
      },
      () => {
        settled = true;
        return "interrupted";
      },
    );
    while (!mockConversionEnd) await new Promise((done) => setImmediate(done));
    controller.abort(new Error("synthetic stop"));
    expect(mockConversionKill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    mockConversionEnd();
    mockConversionEnd = undefined;
    mockHoldConversion = false;
    expect(await outcome).toBe("interrupted");
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(uploadObjectToS3).not.toHaveBeenCalled();
  });

  it("fences a provider result returned after processing ownership is lost", async () => {
    let resume!: (value: { text: string }) => void;
    const held = new Promise<{ text: string }>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mockTranscribe.mockImplementationOnce(() => {
      entered();
      return held;
    });
    const controller = new AbortController();
    const processing = processPersonalMediaUpload(
      buildJob(),
      "instance-1",
      controller.signal,
    );
    await started;
    expect(mockTranscribe.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort(new Error("synthetic ownership loss"));
    resume({ text: "late synthetic transcript" });
    await expect(processing).rejects.toThrow("synthetic ownership loss");
    expect(writeMeetingHistoryService).not.toHaveBeenCalled();
    expect(updateClaimedPersonalMediaUploadJobRecord).not.toHaveBeenCalled();
    expect(uploadObjectToS3).not.toHaveBeenCalled();
  });

  it("reports unavailable segment counts when every progress read fails", async () => {
    jest
      .mocked(listPersonalRecordingUploadSegments)
      .mockRejectedValue(new Error("database unavailable"));
    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
      "instance-1",
    );
    expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
      "upload-1",
      expect.objectContaining({
        processedSegmentCount: null,
        segmentCount: null,
        jobStatus: "failed",
      }),
    );
  });

  it("requeues a final progress read failure before the last attempt", async () => {
    recordingSegments = [buildSegment(0)];
    jest
      .mocked(listPersonalRecordingUploadSegments)
      .mockImplementation(async () => {
        if (
          mockUploadedObjects.has(
            "personal/user-1/upload-1/attempt-2/transcript.json",
          )
        )
          throw new Error("progress unavailable");
        return recordingSegments;
      });
    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 2 },
      "instance-1",
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "queued", retryable: true }),
      "instance-1",
    );
    expect(writeMeetingHistoryService).not.toHaveBeenCalled();
    expect(recordPersonalUploadTerminal).not.toHaveBeenCalled();
  });

  it.each(["naming", "progress", "persistent progress"])(
    "retains partial outcomes and counts after final %s failure",
    async (boundary) => {
      recordingSegments = [buildSegment(0), buildSegment(1)];
      mockTranscribe
        .mockResolvedValueOnce({ text: "usable transcript" })
        .mockRejectedValueOnce(new Error("provider unavailable"));
      if (boundary === "naming") {
        jest
          .mocked(resolveMeetingNameFromSummary)
          .mockRejectedValueOnce(new Error("database unavailable"));
      } else {
        let rejected = false;
        jest
          .mocked(listPersonalRecordingUploadSegments)
          .mockImplementation(async () => {
            if (
              (!rejected || boundary === "persistent progress") &&
              mockUploadedObjects.has(
                "personal/user-1/upload-1/attempt-3/transcript.json",
              )
            ) {
              rejected = true;
              throw new Error("progress unavailable");
            }
            return recordingSegments;
          });
      }
      await processPersonalMediaUpload(
        { ...buildDesktopJob(), attempts: 3 },
        "instance-1",
      );
      const processing = {
        transcription: "partial",
        notes: "generated",
        summary: "generated",
      };
      expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "complete", processing }),
      );
      expect(
        updateClaimedPersonalMediaUploadJobRecord,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed", retryable: false }),
        "instance-1",
      );
      expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
        "upload-1",
        expect.objectContaining({
          processing,
          failedChunks: 1,
          processedSegmentCount: 1,
          segmentCount: 2,
          jobStatus: "failed",
        }),
      );
    },
  );

  it("persists a personal attendee participant before processing", async () => {
    await createPersonalMediaProcessingMeeting(buildJob(), "instance-1");

    expect(writeMeetingHistoryService).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "personal:user-1",
        channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
        ownershipScope: "personal",
        ownerUserId: "user-1",
        participants: [
          {
            id: "user-1",
            username: "Me",
            displayName: "Me",
          },
        ],
      }),
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: "upload-1",
        meetingGuildId: "personal:user-1",
        meetingId: "upload-1",
        channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
      }),
      "instance-1",
    );
  });

  it("processes recording segments independently and stores transcript artifacts", async () => {
    recordingSegments = [buildSegment(0), buildSegment(1)];

    await processPersonalMediaUpload(buildDesktopJob(), "instance-1");

    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    expect(markPersonalRecordingUploadSegmentProcessed).toHaveBeenCalledTimes(
      2,
    );
    expect(recordingSegments).toEqual([
      expect.objectContaining({
        status: "processed",
        transcriptS3Key:
          "personal/user-1/upload-1/attempt-1/segments/owner_mic-000000.transcript.json",
      }),
      expect.objectContaining({
        status: "processed",
        transcriptS3Key:
          "personal/user-1/upload-1/attempt-1/segments/owner_mic-000001.transcript.json",
      }),
    ]);
    expect(
      updateClaimedPersonalMediaUploadJobProgress,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        uploadId: "upload-1",
        instanceId: "instance-1",
        segmentCount: 2,
        uploadedSegmentCount: 2,
        processedSegmentCount: 2,
      }),
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        segmentCount: 2,
        processedSegmentCount: 2,
      }),
      "instance-1",
    );
  });

  it("skips desktop sources that did not produce segments", async () => {
    recordingSegments = [buildSegment(0)];
    const job = {
      ...buildDesktopJob(),
      sourceManifest: [
        { sourceId: "owner_mic", kind: "owner_mic", label: "Me" },
        {
          sourceId: "system_output",
          kind: "system_output",
          label: "System/Other",
        },
      ],
    } satisfies PersonalMediaUploadJobRecord;

    await processPersonalMediaUpload(job, "instance-1");

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(markPersonalRecordingUploadSegmentProcessed).toHaveBeenCalledTimes(
      1,
    );
    expect(recordingSegments).toEqual([
      expect.objectContaining({ sourceId: "owner_mic", status: "processed" }),
    ]);
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        segmentCount: 1,
        processedSegmentCount: 1,
      }),
      "instance-1",
    );
  });

  it("reuses processed segment transcript artifacts on retry", async () => {
    const processedSegment = {
      ...buildSegment(0, "processed"),
      transcriptS3Key:
        "personal/user-1/upload-1/attempt-1/segments/owner_mic-000000.transcript.json",
    };
    recordingSegments = [processedSegment];
    mockUploadedObjects.set(
      processedSegment.transcriptS3Key,
      JSON.stringify({
        generatedAt: "2026-01-06T18:00:00.000Z",
        uploadId: "upload-1",
        segmentKey: processedSegment.segmentKey,
        sourceId: "owner_mic",
        sequence: 0,
        text: "cached transcript",
        segment: {
          userId: "user-1",
          username: "Me",
          displayName: "Me",
          startedAt: processedSegment.startedAt,
          text: "cached transcript",
          source: "desktop_recording",
        },
      }),
    );

    await processPersonalMediaUpload(buildDesktopJob(), "instance-1");

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(markPersonalRecordingUploadSegmentProcessing).not.toHaveBeenCalled();
    expect(fetchJsonFromS3).toHaveBeenCalledWith(
      processedSegment.transcriptS3Key,
      undefined,
    );
    expect(uploadObjectToS3).toHaveBeenCalledWith(
      "personal/user-1/upload-1/attempt-1/transcript.json",
      expect.stringContaining("cached transcript"),
      "application/json",
      { signal: undefined },
    );
  });

  it("records an empty desktop recording without generating notes", async () => {
    recordingSegments = [buildSegment(0)];
    mockTranscribe.mockResolvedValue({ text: "   " });

    await processPersonalMediaUpload(buildDesktopJob(), "instance-1");

    expectEmptyUploadWithoutNotes();
  });

  it("records an empty ordinary upload without generating notes", async () => {
    mockTranscribe.mockResolvedValue({ text: "   " });

    await processPersonalMediaUpload(buildJob(), "instance-1");

    expectEmptyUploadWithoutNotes();
  });

  it("salvages cached text on the last attempt and leaves the failed segment failed", async () => {
    const cached = {
      ...buildSegment(0, "processed"),
      transcriptS3Key: "cached.json",
    };
    recordingSegments = [cached, buildSegment(1)];
    mockUploadedObjects.set(
      "cached.json",
      JSON.stringify({
        segment: {
          userId: "user-1",
          username: "Me",
          displayName: "Me",
          startedAt: cached.startedAt,
          text: "cached transcript",
          source: "desktop_recording",
        },
      }),
    );
    mockTranscribe.mockRejectedValue(new Error("provider failed"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(recordingSegments).toEqual([
      expect.objectContaining({ status: "processed" }),
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "Generated notes",
        processing: {
          transcription: "partial",
          notes: "generated",
          summary: "generated",
        },
      }),
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ processedSegmentCount: 1, status: "complete" }),
      "instance-1",
    );
  });

  it("requeues a provider failure before the last attempt", async () => {
    recordingSegments = [buildSegment(0)];
    mockTranscribe.mockRejectedValue(new Error("provider failed"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 2 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).not.toHaveBeenCalled();
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "queued", retryable: true }),
      "instance-1",
    );
  });

  it("records terminal failure when every final-attempt chunk fails", async () => {
    recordingSegments = [buildSegment(0)];
    mockTranscribe.mockRejectedValue(new Error("provider failed"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        processing: {
          transcription: "failed",
          notes: "skipped",
          summary: "skipped",
        },
      }),
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", retryable: false }),
      "instance-1",
    );
  });

  it("treats mixed empty and failed chunks as terminal failure", async () => {
    recordingSegments = [buildSegment(0), buildSegment(1)];
    mockTranscribe
      .mockResolvedValueOnce({ text: "   " })
      .mockRejectedValueOnce(new Error("provider failed"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processing: expect.objectContaining({ transcription: "failed" }),
      }),
    );
    expect(recordingSegments).toEqual([
      expect.objectContaining({ status: "processed" }),
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
      "upload-1",
      expect.objectContaining({
        failedChunks: 1,
        processedSegmentCount: 1,
        segmentCount: 2,
        jobStatus: "failed",
        processing: expect.objectContaining({ transcription: "failed" }),
      }),
    );
  });

  it("does not convert an ordinary final-attempt provider failure to empty", async () => {
    mockTranscribe.mockRejectedValue(new Error("provider failed"));

    await processPersonalMediaUpload(
      { ...buildJob(), attempts: 3 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processing: expect.objectContaining({ transcription: "failed" }),
      }),
    );
    expect(mockCreateResponse).not.toHaveBeenCalled();
  });

  it("keeps an S3 artifact failure as a failed job", async () => {
    jest
      .mocked(uploadObjectToS3)
      .mockRejectedValueOnce(new Error("S3 unavailable"));

    await processPersonalMediaUpload(
      { ...buildJob(), attempts: 3 },
      "instance-1",
    );

    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", retryable: false }),
      "instance-1",
    );
    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
      }),
    );
  });

  it("records an empty summary helper result as failed", async () => {
    mockGenerateSummaries.mockResolvedValue({});

    await processPersonalMediaUpload(buildJob(), "instance-1");

    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "failed",
        },
      }),
    );
  });

  it("retains resolved outcomes when the first final history write fails", async () => {
    jest
      .mocked(writeMeetingHistoryService)
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce(undefined);

    await processPersonalMediaUpload(
      { ...buildJob(), attempts: 3 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
      }),
    );
    expect(updateClaimedPersonalMediaUploadJobRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
      "instance-1",
    );
  });

  it("splits every upload by duration and lets the provider detect the language", async () => {
    await processPersonalMediaUpload(buildJob(), "instance-1");

    const segmentCommands = jest
      .mocked(ffmpeg)
      .mock.results.map(
        (result) => result.value as { outputOptionList: string[] },
      )
      .filter((command) => command.outputOptionList.includes("segment"));
    expect(segmentCommands).toHaveLength(1);
    expect(segmentCommands[0].outputOptionList).toEqual(
      expect.arrayContaining([
        "-segment_time",
        String(PERSONAL_UPLOAD_TRANSCRIPTION_CHUNK_SECONDS),
      ]),
    );
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockTranscribe.mock.calls[0][0]).not.toHaveProperty("language");
  });

  it("excludes the failure placeholder from an ordinary upload", async () => {
    mockTranscribe.mockResolvedValue({
      text: TRANSCRIPTION_FAILURE_PLACEHOLDER,
    });

    await processPersonalMediaUpload(buildJob(), "instance-1");

    expect(mockCreateResponse).not.toHaveBeenCalled();
    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "",
        processing: expect.objectContaining({ transcription: "empty" }),
      }),
    );
  });

  it("excludes a cached failure placeholder and keeps failed audio in the artifact", async () => {
    const cached = {
      ...buildSegment(0, "processed"),
      transcriptS3Key: "cached-placeholder.json",
    };
    recordingSegments = [cached, buildSegment(1)];
    mockUploadedObjects.set(
      cached.transcriptS3Key,
      JSON.stringify({
        segment: {
          userId: "user-1",
          username: "Me",
          displayName: "Me",
          startedAt: cached.startedAt,
          text: TRANSCRIPTION_FAILURE_PLACEHOLDER,
          source: "desktop_recording",
        },
      }),
    );
    mockTranscribe.mockRejectedValue(new Error("private request body"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(mockCreateResponse).not.toHaveBeenCalled();
    expect(uploadObjectToS3).not.toHaveBeenCalledWith(
      expect.stringContaining("owner_mic-000001.transcript.json"),
      expect.anything(),
      expect.anything(),
    );
    expect(recordingSegments[1]).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(mockConcatLists.join("\n")).toContain("segment-000000");
    expect(mockConcatLists.join("\n")).toContain("segment-000001");
  });

  it("sanitizes caught provider observations", async () => {
    const providerError = Object.assign(new Error("private request body"), {
      code: "private provider code content",
      status: 429,
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockTranscribe.mockRejectedValue(providerError);

    await processPersonalMediaUpload(
      { ...buildJob(), attempts: 3 },
      "instance-1",
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "Personal upload transcription provider failed",
      { errorClass: "Error", code: undefined, status: 429 },
    );
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(
      "private request body",
    );
    errorSpy.mockRestore();
  });

  it("retains partial failed chunk counts when notes generation later fails", async () => {
    const cached = {
      ...buildSegment(0, "processed"),
      transcriptS3Key: "cached-partial.json",
    };
    recordingSegments = [cached, buildSegment(1)];
    mockUploadedObjects.set(
      cached.transcriptS3Key,
      JSON.stringify({
        segment: {
          userId: "user-1",
          username: "Me",
          displayName: "Me",
          startedAt: cached.startedAt,
          text: "cached transcript",
          source: "desktop_recording",
        },
      }),
    );
    mockTranscribe.mockRejectedValue(new Error("provider failed"));
    mockCreateResponse.mockRejectedValueOnce(new Error("notes failed"));

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
      "upload-1",
      expect.objectContaining({
        failedChunks: 1,
        jobStatus: "failed",
        processing: {
          transcription: "partial",
          notes: "failed",
          summary: "skipped",
        },
      }),
    );
  });

  it("preserves a valid completed history when the job completion write fails", async () => {
    recordingSegments = [buildSegment(0)];
    jest
      .mocked(updateClaimedPersonalMediaUploadJobRecord)
      .mockRejectedValueOnce(new Error("job metadata failed"))
      .mockResolvedValueOnce(true);
    jest.mocked(getMeetingHistoryService).mockResolvedValue({
      guildId: "personal:user-1",
      channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
      meetingId: "upload-1",
      channelId: "personal",
      timestamp: "2026-01-06T18:00:00.000Z",
      notes: "Generated notes",
      participants: [],
      duration: 1,
      transcribeMeeting: true,
      generateNotes: true,
      status: "complete",
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "generated",
      },
    });

    await processPersonalMediaUpload(
      { ...buildDesktopJob(), attempts: 3 },
      "instance-1",
    );

    expect(writeMeetingHistoryService).toHaveBeenCalledTimes(1);
    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "Generated notes",
        processing: expect.objectContaining({ transcription: "ready" }),
      }),
    );
    expect(recordPersonalUploadTerminal).toHaveBeenLastCalledWith(
      "upload-1",
      expect.objectContaining({
        jobStatus: "failed",
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
      }),
    );
  });
});
