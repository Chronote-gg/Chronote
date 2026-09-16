import { jest } from "@jest/globals";
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
  updatePersonalMediaUploadJobRecord,
} from "../personalMediaUploadService";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "../personalMediaUploadProcessingService";
import { fetchJsonFromS3, uploadObjectToS3 } from "../storageService";

const mockUploadedObjects = new Map<string, string | Buffer>();
const mockTranscribe = jest.fn(async () => ({ text: "segment transcript" }));
const mockChatComplete = jest.fn(async () => ({
  choices: [{ message: { content: "Generated notes" } }],
}));

jest.mock("fluent-ffmpeg", () => {
  const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const path = jest.requireActual<typeof import("node:path")>("node:path");

  const ffmpeg = jest.fn(() => {
    const command = {
      outputPath: "",
      endHandler: undefined as undefined | (() => void),
      noVideo() {
        return this;
      },
      audioCodec() {
        return this;
      },
      audioBitrate() {
        return this;
      },
      audioChannels() {
        return this;
      },
      audioFrequency() {
        return this;
      },
      input() {
        return this;
      },
      inputOptions() {
        return this;
      },
      outputOptions() {
        return this;
      },
      complexFilter() {
        return this;
      },
      output(outputPath: string) {
        this.outputPath = outputPath;
        return this;
      },
      on(event: string, handler: () => void) {
        if (event === "end") this.endHandler = handler;
        return this;
      },
      run() {
        if (this.outputPath) {
          fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
          fs.writeFileSync(this.outputPath, Buffer.from("audio"));
        }
        this.endHandler?.();
        return this;
      },
    };
    return command;
  });
  Object.assign(ffmpeg, {
    ffprobe: jest.fn(
      (
        _filePath: string,
        callback: (
          error: null,
          metadata: { format: { duration: number } },
        ) => void,
      ) => callback(null, { format: { duration: 1 } }),
    ),
  });
  return ffmpeg;
});

jest.mock("../meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(async () => undefined),
  writeMeetingHistoryService: jest.fn(async () => undefined),
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
  updatePersonalMediaUploadJobRecord: jest.fn(async () => undefined),
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
    chat: { completions: { create: mockChatComplete } },
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
  generateMeetingSummaries: jest.fn(async () => ({
    summarySentence: "Summary",
    summaryLabel: "Label",
  })),
}));

jest.mock("../meetingNameService", () => ({
  resolveMeetingNameFromSummary: jest.fn(async () => "Meeting name"),
}));

jest.mock("../notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(async () => undefined),
}));

const buildJob = (): PersonalMediaUploadJobRecord => ({
  uploadId: "upload-1",
  ownerUserId: "user-1",
  status: "queued",
  mediaKind: "audio",
  sourceS3Key: "personal-media-uploads/user-1/upload-1/source.mp3",
  contentType: "audio/mpeg",
  fileSize: 1234,
  createdAt: "2026-01-06T18:00:00.000Z",
  updatedAt: "2026-01-06T18:00:00.000Z",
});

const buildDesktopJob = (): PersonalMediaUploadJobRecord => ({
  ...buildJob(),
  uploadOrigin: "desktop_recording",
  sourceS3Key: "personal-media-uploads/user-1/upload-1/segments/",
  sourceManifest: [{ sourceId: "owner_mic", kind: "owner_mic", label: "Me" }],
  contentType: "audio/wav",
  fileSize: 2000,
  status: "processing",
  processingOwnerInstanceId: "instance-1",
});

const buildSegment = (
  sequence: number,
  status: PersonalRecordingSegmentRecord["status"] = "submitted",
): PersonalRecordingSegmentRecord => ({
  uploadId: "upload-1",
  segmentKey: `owner_mic#${String(sequence).padStart(6, "0")}`,
  ownerUserId: "user-1",
  sourceId: "owner_mic",
  sequence,
  kind: "owner_mic",
  label: "Me",
  sourceS3Key: `personal-media-uploads/user-1/upload-1/segments/owner_mic-${String(sequence).padStart(6, "0")}.wav`,
  contentType: "audio/wav",
  fileSize: 1000,
  checksumSha256: "a".repeat(64),
  durationMillis: 1000,
  startedAt: `2026-01-06T18:00:0${sequence}.000Z`,
  endedAt: `2026-01-06T18:00:0${sequence + 1}.000Z`,
  status,
  createdAt: "2026-01-06T18:00:00.000Z",
  updatedAt: "2026-01-06T18:00:00.000Z",
});

let recordingSegments: PersonalRecordingSegmentRecord[] = [];

const replaceSegment = (next: PersonalRecordingSegmentRecord) => {
  recordingSegments = recordingSegments.map((segment) =>
    segment.segmentKey === next.segmentKey ? next : segment,
  );
  return next;
};

describe("personalMediaUploadProcessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadedObjects.clear();
    recordingSegments = [];
    mockTranscribe.mockResolvedValue({ text: "segment transcript" });
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

  it("persists a personal attendee participant before processing", async () => {
    await createPersonalMediaProcessingMeeting(buildJob());

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
    expect(updatePersonalMediaUploadJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: "upload-1",
        meetingGuildId: "personal:user-1",
        meetingId: "upload-1",
        channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
      }),
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
          "personal/user-1/upload-1/segments/owner_mic-000000.transcript.json",
      }),
      expect.objectContaining({
        status: "processed",
        transcriptS3Key:
          "personal/user-1/upload-1/segments/owner_mic-000001.transcript.json",
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
        "personal/user-1/upload-1/segments/owner_mic-000000.transcript.json",
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
    );
    expect(uploadObjectToS3).toHaveBeenCalledWith(
      "personal/user-1/upload-1/transcript.json",
      expect.stringContaining("cached transcript"),
      "application/json",
    );
  });

  it("records an empty desktop recording without generating notes", async () => {
    recordingSegments = [buildSegment(0)];
    mockTranscribe.mockResolvedValue({ text: "   " });

    await processPersonalMediaUpload(buildDesktopJob(), "instance-1");

    expect(mockChatComplete).not.toHaveBeenCalled();
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
  });

  it("records an empty ordinary upload without generating notes", async () => {
    mockTranscribe.mockResolvedValue({ text: "   " });

    await processPersonalMediaUpload(buildJob(), "instance-1");

    expect(mockChatComplete).not.toHaveBeenCalled();
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
    expect(mockChatComplete).not.toHaveBeenCalled();
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
  });
});
