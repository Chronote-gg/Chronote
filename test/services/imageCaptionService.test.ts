import type { MeetingData } from "../../src/types/meeting-data";
import type { ChatEntry } from "../../src/types/chat";
import type { Participant } from "../../src/types/participants";

const buildMeeting = (chatLog: ChatEntry[]): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
    chatLog,
    runtimeConfig: {
      transcription: {
        suppressionEnabled: false,
        suppressionHardSilenceDbfs: -60,
        suppressionRateMaxSeconds: 30,
        suppressionRateMinWords: 1,
        suppressionRateMinSyllables: 1,
        suppressionRateMaxSyllablesPerSecond: 12,
        promptEchoEnabled: true,
        voteEnabled: true,
        fastSilenceMs: 0,
        slowSilenceMs: 0,
        minSnippetSeconds: 0,
        maxSnippetMs: 0,
        fastFinalizationEnabled: false,
        interjectionEnabled: false,
        interjectionMinSpeakerSeconds: 0,
        noiseGate: {
          enabled: false,
          windowMs: 0,
          peakDbfs: 0,
          minActiveWindows: 0,
          minPeakAboveNoiseDb: 0,
          applyToFast: false,
          applyToSlow: false,
        },
        finalPassEnabled: false,
      },
      premiumTranscription: {
        enabled: false,
        cleanupEnabled: false,
      },
      dictionary: {
        maxEntries: 0,
        maxCharsTranscription: 0,
        maxCharsContext: 0,
      },
      autoRecordCancellation: {
        enabled: false,
      },
      visionCaptions: {
        enabled: true,
        maxImages: 10,
        maxTotalChars: 3000,
      },
      modelParams: {},
      modelChoices: {},
    },
  }) as MeetingData;

const buildParticipant = (): Participant => ({
  id: "user-2",
  username: "test",
  displayName: "Test",
  serverNickname: "Test",
});

const loadModule = async (responseContent: string) => {
  jest.resetModules();
  const responsesCreate = jest.fn().mockResolvedValue({
    status: "completed",
    output_text: responseContent,
    output: [],
  });
  const createOpenAIClient = jest.fn(() => ({
    responses: { create: responsesCreate },
  }));

  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient,
  }));

  const module = await import("../../src/services/imageCaptionService");
  return { module, responsesCreate };
};

describe("imageCaptionService", () => {
  test("captionMeetingImages captions image attachments and writes fields", async () => {
    const { module, responsesCreate } = await loadModule(
      JSON.stringify({
        caption: "A diagram of the system.",
        visibleText: "Build -> Test -> Deploy",
      }),
    );
    const participant = buildParticipant();
    const chatLog: ChatEntry[] = [
      {
        type: "message",
        user: participant,
        channelId: "channel-1",
        content: "",
        messageId: "msg-1",
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [
          {
            id: "att-1",
            name: "diagram.png",
            size: 1000,
            url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
            contentType: "image/png",
          },
          {
            id: "att-2",
            name: "notes.pdf",
            size: 1000,
            url: "https://cdn.discordapp.com/attachments/mock/notes.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    ];
    const meeting = buildMeeting(chatLog);
    meeting.runtimeConfig!.modelChoices.imageCaption = "gpt-5.6-luna";

    const result = await module.captionMeetingImages(meeting);

    expect(result.candidates).toBe(1);
    expect(result.captioned).toBe(1);
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-luna",
        temperature: 0,
        reasoning: { effort: "none" },
        max_output_tokens: 300,
        text: { format: { type: "json_object" } },
        store: false,
        input: [
          expect.objectContaining({ role: "system" }),
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Caption this image and extract visible text. Filename: diagram.png",
              },
              {
                type: "input_image",
                image_url:
                  "https://cdn.discordapp.com/attachments/mock/diagram.png",
                detail: "low",
              },
            ],
          },
        ],
      }),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
    expect(meeting.chatLog[0].attachments?.[0].aiCaption).toContain("diagram");
    expect(meeting.chatLog[0].attachments?.[0].aiVisibleText).toContain(
      "Build",
    );
    expect(meeting.chatLog[0].attachments?.[0].aiCaptionedAt).toMatch(/Z$/);
    expect(meeting.chatLog[0].attachments?.[0].aiCaptionModel).toBe(
      "gpt-5.6-luna",
    );
    expect(meeting.chatLog[0].attachments?.[1].aiCaption).toBeUndefined();
  });

  test("captionMeetingImages respects maxTotalChars", async () => {
    const { module } = await loadModule(
      JSON.stringify({
        caption: "1234567890",
        visibleText: "abcdefghij",
      }),
    );
    const participant = buildParticipant();
    const chatLog: ChatEntry[] = [
      {
        type: "message",
        user: participant,
        channelId: "channel-1",
        content: "",
        messageId: "msg-1",
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [
          {
            id: "att-1",
            name: "diagram.png",
            size: 1000,
            url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
            contentType: "image/png",
          },
        ],
      },
    ];
    const meeting = buildMeeting(chatLog);
    meeting.runtimeConfig!.visionCaptions.maxTotalChars = 5;

    await module.captionMeetingImages(meeting);

    expect(
      meeting.chatLog[0].attachments?.[0].aiCaption?.length,
    ).toBeLessThanOrEqual(5);
  });

  test("captionMeetingImages skips empty caption payloads", async () => {
    const { module } = await loadModule(
      JSON.stringify({
        caption: "",
        visibleText: "",
      }),
    );
    const participant = buildParticipant();
    const chatLog: ChatEntry[] = [
      {
        type: "message",
        user: participant,
        channelId: "channel-1",
        content: "",
        messageId: "msg-1",
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [
          {
            id: "att-1",
            name: "diagram.png",
            size: 1000,
            url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
            contentType: "image/png",
          },
        ],
      },
    ];
    const meeting = buildMeeting(chatLog);

    const result = await module.captionMeetingImages(meeting);

    expect(result.candidates).toBe(1);
    expect(result.captioned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(meeting.chatLog[0].attachments?.[0].aiCaption).toBeUndefined();
    expect(meeting.chatLog[0].attachments?.[0].aiVisibleText).toBeUndefined();
    expect(meeting.chatLog[0].attachments?.[0].aiCaptionModel).toBeUndefined();
    expect(meeting.chatLog[0].attachments?.[0].aiCaptionedAt).toBeUndefined();
  });
});

test("interruption holds actual caption SDK and fences late attachment writes", async () => {
  const { module, responsesCreate } = await loadModule("{}");
  const { stopMeetingProcessing } =
    await import("../../src/services/meetingProcessingLifetime");
  const attachment = {
    id: "synthetic-image",
    name: "image.png",
    url: "https://example.invalid/image.png",
    size: 1,
    contentType: "image/png",
  };
  const meeting = buildMeeting([
    {
      type: "message",
      user: buildParticipant(),
      channelId: "synthetic",
      content: "",
      messageId: "synthetic",
      timestamp: new Date(0).toISOString(),
      attachments: [attachment],
    },
  ]);
  let release!: (value: unknown) => void;
  responsesCreate.mockReturnValueOnce(
    new Promise((done) => {
      release = done;
    }),
  );
  const actual = module.captionMeetingImages(meeting);
  const outcome = actual.then(
    () => "success",
    () => "cancelled",
  );
  let drained = false;
  const drain = stopMeetingProcessing(meeting).then(() => {
    drained = true;
  });
  await Promise.resolve();
  const heldBeforeRelease = !drained;
  const signal = responsesCreate.mock.calls[0][1].signal as AbortSignal;
  release({
    status: "completed",
    output_text: JSON.stringify({ caption: "late", visibleText: "" }),
    output: [],
  });
  await drain;
  expect(await outcome).toBe("cancelled");
  expect(heldBeforeRelease).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(attachment).not.toHaveProperty("aiCaption");
});
