import { Collection, type ButtonInteraction } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("../../src/services/meetingCompletionPolicyService", () => ({
  ...jest.requireActual("../../src/services/meetingCompletionPolicyService"),
  // This orchestration fixture replaces history persistence; exact policy CAS is tested separately.
  publishCompletionPolicy: jest.fn(async () => {}),
}));

jest.mock("../../src/services/notesPromptService", () => ({
  prepareLiveNotesPrompt: jest.fn(async () => ({
    messages: [],
    promptVisibleRoleIds: [],
  })),
}));

jest.mock("../../src/services/recordingDeliveryService", () => ({
  ...jest.requireActual("../../src/services/recordingDeliveryService"),
  acknowledgeRecordingDeliveryHistory: jest.fn(async () => {}),
}));

jest.mock("../../src/services/ownedMeetingInterruption", () => ({
  interruptOwnedMeeting: jest.fn(async () => ({ kind: "unresolved" })),
}));

jest.mock("../../src/services/notesService", () => ({ getNotes: jest.fn() }));

jest.mock("@langfuse/tracing", () => ({
  ...jest.requireActual("@langfuse/tracing"),
  updateActiveObservation: jest.fn(),
}));

jest.mock("../../src/services/guildVoiceOperationService", () => ({
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
}));

jest.mock("../../src/services/recordingLimitService", () => ({
  notifyRecordingLimit: jest.fn(),
}));

jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));

jest.mock("../../src/services/transcriptCompilationService", () => {
  const compileTranscriptions = jest.fn();
  return {
    compileTranscriptions,
    createMeetingTranscriptCompiler: jest.fn(
      (client: unknown, meeting: unknown) => (options: unknown) =>
        compileTranscriptions(client, meeting, options),
    ),
  };
});

jest.mock("../../src/audio", () => ({
  stopRecordingCapture: jest.fn(),
  buildMixedAudio: jest.fn(),
  cleanupSpeakerTracks: jest.fn(),
  closeOutputFile: jest.fn(),
  closeFailedInitializationOutput: jest.fn(async () => true),
  startProcessingSnippet: jest.fn(),
  waitForAudioOnlyFinishProcessing: jest.fn(),
  waitForFinishProcessing: jest.fn(),
}));

jest.mock("../../src/embed", () => ({
  updateMeetingMessage:
    jest.requireActual("../../src/embed").updateMeetingMessage,
  updateMeetingProcessingMessage: jest.fn(),
  updateMeetingSummaryMessage: jest.fn(),
}));

jest.mock("../../src/util", () => ({
  deleteDirectoryRecursively: jest.fn(),
  deleteIfExists: jest.fn(),
}));

jest.mock("../../src/services/tempFileService", () => ({
  cleanupMeetingTempDir: jest.fn(),
  ensureMeetingTempDir: jest.fn(async () => "tmp/meetings/meeting-1"),
  getMeetingTempDir: jest.fn(() => "tmp/meetings/meeting-1"),
  retainMeetingTempDir: jest.fn(async () => "tmp/retained-meetings/meeting-1"),
}));

jest.mock("../../src/services/meetingNotesService", () => ({
  ensureMeetingNotes: jest.fn(),
  ensureMeetingSummaries: jest.fn(),
}));

jest.mock("../../src/commands/saveMeetingHistory", () => ({
  saveMeetingHistoryToDatabase: jest.fn(),
}));

jest.mock("../../src/services/meetingHistoryService", () => ({
  transitionOwnedMeetingHistoryService: jest.fn(),
  saveOwnedMeetingHistoryService: jest.fn(),
}));

jest.mock("../../src/utils/chatLog", () => ({
  renderChatEntryLine: jest.fn().mockReturnValue(""),
}));

jest.mock("../../src/services/uploadService", () => ({
  uploadMeetingArtifacts: jest.fn(),
}));

jest.mock("../../src/services/transcriptionFinalPassService", () => ({
  runTranscriptionFinalPass: jest.fn(),
}));

jest.mock("../../src/services/subscriptionService", () => ({
  getGuildLimits: jest.fn(),
}));

jest.mock("../../src/audio/soundCues", () => ({
  stopThinkingCueLoop: jest.fn(),
}));

jest.mock("../../src/observability/meetingTrace", () => ({
  withMeetingEndTrace: jest.fn(),
  withMeetingEndStep: jest.fn(
    (_meeting: unknown, _name: string, run: () => unknown) => run(),
  ),
}));

jest.mock("../../src/services/autoRecordCancellationService", () => ({
  evaluateAutoRecordCancellation: jest.fn(),
}));

jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  releaseMeetingLeaseForMeeting: jest.fn(),
  isReservationControlEligible: jest.fn(() => false),
}));

jest.mock("../../src/services/autoRecordJoinSuppressionService", () => ({
  __esModule: true,
  autoRecordJoinSuppressionService: {
    suppressUntilEmpty: jest.fn(),
  },
}));

jest.mock("../../src/metrics", () => ({
  meetingsCancelled: { inc: jest.fn() },
}));

jest.mock("../../src/utils/meetingLifecycle", () => ({
  ...jest.requireActual("../../src/utils/meetingLifecycle"),
  describeAutoRecordRule: jest.fn(),
}));

jest.mock("../../src/meetings", () => ({
  deleteMeeting: jest.fn(),
  getMeeting: jest.fn(),
  hasMeeting: jest.fn(),
  restoreVoiceSessionNickname: jest.fn(),
}));

jest.mock("../../src/services/meetingUsageService", () => ({
  getNextAvailableAt: jest.fn(),
  getRollingUsageForGuild: jest.fn(),
  getRollingWindowMs: jest.fn(),
}));

jest.mock("../../src/utils/upgradePrompt", () => ({
  buildUpgradeTextOnly: jest.fn((content: string) => content),
}));

jest.mock("node:fs", () => ({
  mkdirSync: jest.fn(),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
  },
  writeFileSync: jest.fn(),
}));

export const successfulArtifactUpload = {
  audioUploadExpected: true,
  chatUploadExpected: true,
  transcriptUploadExpected: false,
  audioS3Key: "audio/meeting-1.mp3",
  chatS3Key: "chat/meeting-1.json",
};

export function finalizationFixture(): MeetingData {
  return {
    guildId: "h4-guild",
    guild: { id: "h4-guild", name: "Fixture guild" },
    meetingId: "h4-meeting",
    startTime: new Date(),
    creator: { id: "creator" },
    attendance: new Set(),
    participants: new Map(),
    voiceChannel: { id: "voice", name: "Voice" },
    textChannel: { id: "text" },
    audioData: {
      audioFiles: [],
      currentSnippets: new Map(),
      outputFileName: "audio",
    },
    chatLog: [],
    setFinished: jest.fn(),
    transcribeMeeting: false,
    reservation: {
      sessionMode: "meeting",
      guildId: "h4-guild",
      meetingId: "h4-meeting",
      ownerInstanceId: "owner",
      executionVersion: 1,
      historyKey: { guildId: "h4-guild", channelId_timestamp: "key" },
      workHandle: { transition: jest.fn(), settle: jest.fn() },
    },
  } as unknown as MeetingData;
}

export function recordingLimitMeeting(events: string[]) {
  const connection = {
    disconnect: jest.fn(() => {
      events.push("disconnect");
    }),
    destroy: jest.fn(() => {
      events.push("destroy");
    }),
  };

  const meeting = {
    attendance: new Set<string>(),
    reservation: {
      guildId: "guild-1",
      meetingId: "meeting-1",
      sessionMode: "meeting",
      ownerInstanceId: "fixture",
      executionVersion: 1,
      voiceOperationAttemptId: "attempt",
      reservedAt: 100,
      historyKey: {
        guildId: "guild-1",
        channelId_timestamp: "voice-1#fixture",
      },
      workHandle: { settle: jest.fn(), transition: jest.fn() },
    },
    guildId: "guild-1",
    channelId: "original-notes",
    startMessageId: "published-recording",
    meetingId: "meeting-1",
    voiceChannel: { id: "voice-1", name: "Voice" },
    textChannel: {
      id: "original-notes",
      send: jest.fn(),
      messages: { fetch: jest.fn() },
    },
    connection,
    chatLog: [],
    audioData: {
      audioFiles: [],
      currentSnippets: new Map([
        [
          "user-1",
          {
            userId: "user-1",
            timestamp: Date.now(),
            chunks: [Buffer.from("test")],
            fastRevision: 0,
            fastTranscribed: false,
          },
        ],
      ]),
      outputFileName: "recording.mp3",
    },
    ...recordingOnlyFinalizationState(),
  } as unknown as MeetingData;
  return { meeting, connection };
}

export function recordingOnlyFinalizationState() {
  return {
    startTime: new Date("2025-01-01T00:00:00.000Z"),
    endTime: undefined,
    finishing: false,
    finished: false,
    transcribeMeeting: false,
    generateNotes: false,
    isAutoRecording: false,
    creator: { id: "user-1" },
    guild: { id: "guild-1", name: "Guild", members: { cache: new Map() } },
    ttsQueue: { stopAndClear: jest.fn() },
    setFinished: jest.fn(),
  };
}

export function finalizationCaptureState() {
  return {
    connection: {
      disconnect: jest.fn(),
      destroy: jest.fn(),
    },
    chatLog: [],
    audioData: {
      audioFiles: [],
      currentSnippets: new Map(),
      outputFileName: "recording.mp3",
    },
  };
}

export function autoRecordFinalizationFixture() {
  return {
    ...recordingOnlyFinalizationState(),
    ...finalizationCaptureState(),
    attendance: new Set<string>(),
    guildId: "guild-1",
    channelId: "text-1",
    meetingId: "meeting-1",
    voiceChannel: { id: "voice-1", name: "Voice", members: new Collection() },
    textChannel: {
      send: jest.fn().mockResolvedValue(undefined),
      messages: { fetch: jest.fn() },
    },
    isAutoRecording: true,
    guild: { id: "guild-1", members: { cache: new Map() } },
  };
}

export function acknowledgedEndMeetingButton(): ButtonInteraction {
  return {
    message: { id: "start-message" },
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferUpdate: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

export const successfulFinalPassResult = {
  enabled: true,
  applied: false,
  processedChunks: 0,
  totalChunks: 0,
  totalSegments: 0,
  candidateEdits: 0,
  acceptedEdits: 0,
  replacedSegments: 0,
  droppedSegments: 0,
  rejectedTrivialEdits: 0,
  repetitionFilteredSegments: 0,
  fallbackApplied: false,
};
