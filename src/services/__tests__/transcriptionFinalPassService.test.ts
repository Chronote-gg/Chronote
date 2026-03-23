import { runTranscriptionFinalPass } from "../transcriptionFinalPassService";
import type { MeetingData } from "../../types/meeting-data";

const createMeeting = (transcript: string): MeetingData => {
  const startTime = new Date("2026-03-01T00:00:00.000Z");
  const audioFiles = Array.from({ length: 10 }, (_value, index) => ({
    userId: `user-${index + 1}`,
    timestamp: startTime.getTime() + (index + 1) * 1_000,
    transcript: `${transcript} ${index + 1}`,
    processing: false,
    audioOnlyProcessing: false,
    source: "voice" as const,
  }));

  return {
    meetingId: "meeting-1",
    chatLog: [],
    attendance: new Set(),
    connection: null as never,
    textChannel: null as never,
    voiceChannel: { id: "voice-1" } as never,
    guildId: "guild-1",
    channelId: "channel-1",
    audioData: {
      audioFiles,
      currentSnippets: new Map(),
    },
    startTime,
    endTime: new Date("2026-03-01T00:02:00.000Z"),
    creator: null as never,
    guild: { id: "guild-1" } as never,
    isAutoRecording: false,
    finishing: false,
    isFinished: Promise.resolve(),
    setFinished: () => undefined,
    finished: false,
    transcribeMeeting: true,
    generateNotes: false,
    participants: new Map(),
    runtimeConfig: {
      transcription: {
        finalPassEnabled: true,
      },
    } as never,
  };
};

const buildDependencyOverrides = (replacementText: string) => ({
  ensureTempDir: async () => "temp-dir",
  getAudioDurationSeconds: async () => 120,
  renderAudioChunk: async () => undefined,
  transcribeChunk: async () => ({
    text: "verified transcript",
    logprobs: [],
  }),
  reconcileBatch: async () => [
    {
      segmentId: "seg-1",
      action: "replace" as const,
      text: replacementText,
      confidence: 1,
    },
  ],
  deleteTempFile: async () => undefined,
});

const buildNoEditDependencyOverrides = () => ({
  ensureTempDir: async () => "temp-dir",
  getAudioDurationSeconds: async () => 120,
  renderAudioChunk: async () => undefined,
  transcribeChunk: async () => ({
    text: "verified transcript",
    logprobs: [],
  }),
  reconcileBatch: async () => [],
  deleteTempFile: async () => undefined,
});

describe("runTranscriptionFinalPass", () => {
  it("rejects trivial replacement text", async () => {
    const meeting = createMeeting("Original transcript");

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "meeting.mp3" },
      buildDependencyOverrides("."),
    );

    expect(result.applied).toBe(false);
    expect(result.candidateEdits).toBe(1);
    expect(result.acceptedEdits).toBe(0);
    expect(result.rejectedTrivialEdits).toBe(1);
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBeUndefined();
  });

  it("applies a meaningful replacement", async () => {
    const meeting = createMeeting("Original transcript");

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "meeting.mp3" },
      buildDependencyOverrides("Updated transcript"),
    );

    expect(result.applied).toBe(true);
    expect(result.candidateEdits).toBe(1);
    expect(result.acceptedEdits).toBe(1);
    expect(result.rejectedTrivialEdits).toBe(0);
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBe(
      "Updated transcript",
    );
  });

  it("drops repeated low-information segments for the same speaker", async () => {
    const meeting = createMeeting("Original transcript");
    meeting.audioData.audioFiles = [
      {
        userId: "user-1",
        timestamp: meeting.startTime.getTime() + 1_000,
        transcript: "Hello",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
      {
        userId: "user-1",
        timestamp: meeting.startTime.getTime() + 20_000,
        transcript: "Hello, how are you?",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
      {
        userId: "user-1",
        timestamp: meeting.startTime.getTime() + 45_000,
        transcript: "I have a question.",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
      {
        userId: "user-1",
        timestamp: meeting.startTime.getTime() + 65_000,
        transcript: "I have a question.",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
    ];

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "meeting.mp3" },
      buildNoEditDependencyOverrides(),
    );

    expect(result.applied).toBe(true);
    expect(result.acceptedEdits).toBe(0);
    expect(result.repetitionFilteredSegments).toBe(2);
    expect(result.droppedSegments).toBe(2);
    expect(meeting.audioData.audioFiles[1].finalPassTranscript).toBe("");
    expect(meeting.audioData.audioFiles[3].finalPassTranscript).toBe("");
  });

  it("does not drop low-information segments from different users with the same label", async () => {
    const meeting = createMeeting("Original transcript");
    meeting.participants = new Map([
      [
        "user-1",
        {
          serverNickname: "Alex",
        } as never,
      ],
      [
        "user-2",
        {
          serverNickname: "Alex",
        } as never,
      ],
    ]);
    meeting.audioData.audioFiles = [
      {
        userId: "user-1",
        timestamp: meeting.startTime.getTime() + 1_000,
        transcript: "Hello",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
      {
        userId: "user-2",
        timestamp: meeting.startTime.getTime() + 20_000,
        transcript: "Hello",
        processing: false,
        audioOnlyProcessing: false,
        source: "voice",
      },
    ];

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "meeting.mp3" },
      buildNoEditDependencyOverrides(),
    );

    expect(result.repetitionFilteredSegments).toBe(0);
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBeUndefined();
    expect(meeting.audioData.audioFiles[1].finalPassTranscript).toBeUndefined();
  });
});
