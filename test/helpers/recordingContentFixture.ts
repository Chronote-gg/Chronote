jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/savedRecordingPrompt", () => ({
  ...jest.requireActual("../../src/services/savedRecordingPrompt"),
  snapshotRecordingPrompt: jest.fn(
    async (name: string, type: string, label: string) => ({
      name,
      type,
      label,
      version: 11,
      template:
        type === "text"
          ? "{{transcript}}"
          : [{ role: "user", content: "{{transcript}} {{notes}}" }],
    }),
  ),
}));
jest.mock("../../src/services/contextService", () => ({
  ...jest.requireActual("../../src/services/contextService"),
  collectMeetingContext: jest.fn(async () => ({
    availability: "available",
    data: { serverContext: "original generated context" },
  })),
}));
jest.mock("../../src/services/meetingNameService", () => ({
  listRecentMeetingNamesForPrompt: jest.fn(async () => "Original names"),
}));
jest.mock("prism-media", () => ({
  opus: { Decoder: jest.requireActual("node:stream").PassThrough },
}));
jest.mock("../../src/liveVoice", () => ({ maybeRespondLive: jest.fn() }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeSnippet: jest.fn(),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Recovered true tail",
  })),
}));
jest.mock("../../src/services/transcriptionCleanupService", () => ({
  ...jest.requireActual("../../src/services/transcriptionCleanupService"),
  cleanupContentTranscription: jest.fn(),
}));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  ...jest.requireActual("../../src/services/transcriptionPromptService"),
  getTranscriptionCleanupPrompt: jest.fn(async () => ({
    messages: [{ role: "system", content: "Synthetic cleanup prompt" }],
  })),
}));
import { Collection } from "discord.js";
import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { CheckpointArtifactInput } from "../../src/types/recordingCheckpoint";
export async function fixture(transcribeMeeting = true) {
  const artifacts: CheckpointArtifactInput[] = [];
  const runtimeConfig = await resolveMeetingRuntimeConfig({
    guildId: "generated",
    channelId: "voice",
    userId: "creator",
  });
  const meeting = {
    isAutoRecording: false,
    meetingId: "generated-meeting",
    guildId: "generated",
    channelId: "separate-notes",
    textChannel: { id: "separate-notes", send: jest.fn() },
    transcribeMeeting,
    generateNotes: true,
    captureStartedAt: new Date(2000),
    creator: { id: "creator" },
    runtimeConfig,
    reservation: {
      sessionMode: "meeting",
      meetingId: "generated-meeting",
      guildId: "generated",
      ownerInstanceId: "owner",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      reservedAt: 1000,
      historyKey: {
        guildId: "generated",
        channelId_timestamp: "voice#1970-01-01T00:00:01.000Z",
      },
    },
    ownershipSignal: new AbortController().signal,
    recordingCapture: {
      queueContent: (artifact: CheckpointArtifactInput) => {
        artifacts.push(artifact);
        return true;
      },
    },
    guild: {
      id: "generated",
      name: "Generated server",
      roles: new Collection(),
      scheduledEvents: new Collection(),
      channels: new Collection(),
      members: {},
      client: {},
    },
    voiceChannel: { id: "voice", name: "Generated voice" },
    participants: new Map([
      ["speaker", { id: "speaker", username: "Speaker" }],
    ]),
    attendance: new Set(["<@speaker>"]),
    chatLog: [],
    audioData: { audioFiles: [] },
  } as unknown as MeetingData;
  return { meeting, artifacts };
}
