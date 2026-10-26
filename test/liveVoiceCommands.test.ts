/** @jest-environment node */
import { afterEach, expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: jest.fn() }));
import type { MeetingData } from "../src/types/meeting-data";
import type { Participant } from "../src/types/participants";
import type { LiveSegment } from "../src/liveVoice";

type MemberSpec = {
  id: string;
  canEnd?: boolean;
};

const BOT_ID = "bot-1";

const completedResponse = (text: string) => ({
  status: "completed",
  output_text: text,
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text }],
    },
  ],
});

const makeSegment = (userId: string, text: string): LiveSegment => ({
  userId,
  text,
  timestamp: Date.now(),
});

const makeMeeting = (options: {
  creatorId: string;
  members: MemberSpec[];
  liveVoiceEnabled?: boolean;
  liveVoiceCommandsEnabled?: boolean;
}) => {
  const membersById = new Map<
    string,
    { user: { id: string; username: string } }
  >();
  const permissionsById = new Map<string, boolean>();

  for (const member of options.members) {
    membersById.set(member.id, {
      user: { id: member.id, username: `user-${member.id}` },
    });
    permissionsById.set(member.id, Boolean(member.canEnd));
  }

  const botUser = {
    id: BOT_ID,
    username: "Chronote",
    globalName: "Chronote",
  };

  const participants = new Map<string, Participant>();
  for (const member of options.members) {
    participants.set(member.id, {
      id: member.id,
      username: `user-${member.id}`,
    });
  }

  return {
    guildId: "guild-1",
    channelId: "text-1",
    voiceChannel: { id: "voice-1", name: "General" },
    textChannel: { id: "text-1", name: "general" },
    creator: { id: options.creatorId, client: { user: botUser } },
    guild: {
      name: "Chronote HQ",
      members: {
        cache: {
          get: (id: string) => {
            const member = membersById.get(id);
            if (!member) return undefined;
            return {
              user: member.user,
              permissions: {
                any: jest
                  .fn()
                  .mockReturnValue(permissionsById.get(id) ?? false),
              },
            };
          },
        },
        me: {
          user: botUser,
          displayName: "Chronote",
        },
      },
      client: {
        user: botUser,
        users: {
          cache: new Map(),
        },
      },
    },
    audioData: {
      audioFiles: [],
      currentSnippets: new Map(),
    },
    participants,
    attendance: new Set(),
    chatLog: [],
    liveVoiceEnabled: options.liveVoiceEnabled ?? false,
    liveVoiceCommandsEnabled: options.liveVoiceCommandsEnabled ?? true,
    ttsQueue: {
      enqueue: jest.fn().mockReturnValue(true),
      playCueIfIdle: jest.fn().mockReturnValue(true),
      stopAndClear: jest.fn(),
      size: jest.fn().mockReturnValue(0),
    },
    finishing: false,
    finished: false,
  } as MeetingData;
};

const setupLiveVoice = async (responses: string[]) => {
  const mockCreate = jest.fn();
  for (const content of responses) {
    mockCreate.mockResolvedValueOnce(completedResponse(content));
  }

  jest.doMock("openai", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      responses: { create: mockCreate },
    })),
  }));
  const mockGetLangfuseChatPrompt = jest.fn().mockResolvedValue({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Stub prompt." },
    ],
    source: "langfuse",
    langfusePrompt: {
      name: "chronote-live-voice-gate-chat",
      version: 1,
      isFallback: true,
    },
  });
  jest.doMock("../src/services/langfusePromptService", () => ({
    __esModule: true,
    getLangfuseChatPrompt: mockGetLangfuseChatPrompt,
  }));

  const liveVoice = await import("../src/liveVoice");
  return { maybeRespondLive: liveVoice.maybeRespondLive, mockCreate };
};

afterEach(() => {
  jest.resetModules();
  jest.dontMock("openai");
});

test("starts confirmation when gate returns command_end", async () => {
  const { maybeRespondLive, mockCreate } = await setupLiveVoice([
    '{"action":"command_end"}',
  ]);
  const { config } = await import("../src/services/configService");

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });

  await maybeRespondLive(
    meeting,
    makeSegment("user-1", "Chronote please end the meeting"),
  );

  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      input: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Stub prompt." },
      ],
      text: expect.objectContaining({ format: { type: "json_object" } }),
      max_output_tokens: config.liveVoice.gateMaxOutputTokens,
      store: false,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(meeting.liveVoiceCommandPending?.userId).toBe("user-1");
  expect(meeting.ttsQueue?.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining("Confirm end meeting"),
      priority: "high",
      source: "live_voice",
    }),
  );
});

test("does not start confirmation when user lacks permission", async () => {
  const { maybeRespondLive } = await setupLiveVoice([
    '{"action":"command_end"}',
  ]);

  const meeting = makeMeeting({
    creatorId: "owner-1",
    members: [{ id: "user-1", canEnd: false }],
    liveVoiceCommandsEnabled: true,
  });

  await maybeRespondLive(
    meeting,
    makeSegment("user-1", "Chronote end meeting"),
  );

  expect(meeting.liveVoiceCommandPending).toBeUndefined();
  expect(meeting.ttsQueue?.enqueue).not.toHaveBeenCalled();
});

test("confirms and ends meeting for the requester", async () => {
  const { maybeRespondLive } = await setupLiveVoice(['{"decision":"confirm"}']);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };
  meeting.onEndMeeting = jest.fn().mockResolvedValue(undefined);

  await maybeRespondLive(meeting, makeSegment("user-1", "yes"));

  expect(meeting.onEndMeeting).toHaveBeenCalledTimes(1);
  expect(meeting.liveVoiceCommandPending).toBeUndefined();
});

test("blocks confirmation when requester lacks permission", async () => {
  const { maybeRespondLive } = await setupLiveVoice(['{"decision":"confirm"}']);

  const meeting = makeMeeting({
    creatorId: "owner-1",
    members: [{ id: "user-1", canEnd: false }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };
  meeting.onEndMeeting = jest.fn().mockResolvedValue(undefined);

  await maybeRespondLive(meeting, makeSegment("user-1", "yes"));

  expect(meeting.onEndMeeting).not.toHaveBeenCalled();
  expect(meeting.liveVoiceCommandPending).toBeUndefined();
});

test("denial clears pending and enqueues the denial cue", async () => {
  const { maybeRespondLive } = await setupLiveVoice(['{"decision":"deny"}']);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };

  await maybeRespondLive(meeting, makeSegment("user-1", "no"));

  expect(meeting.liveVoiceCommandPending).toBeUndefined();
  expect(meeting.ttsQueue?.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "sfx",
      label: "live_command_denial",
    }),
  );
});

test("unclear confirmation keeps pending", async () => {
  const { maybeRespondLive } = await setupLiveVoice(['{"decision":"unclear"}']);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };

  await maybeRespondLive(meeting, makeSegment("user-1", "maybe"));

  expect(meeting.liveVoiceCommandPending).toEqual(
    expect.objectContaining({ userId: "user-1" }),
  );
});

test("other user speech does not trigger confirmation handling", async () => {
  const { maybeRespondLive, mockCreate } = await setupLiveVoice([]);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [
      { id: "user-1", canEnd: true },
      { id: "user-2", canEnd: false },
    ],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };

  await maybeRespondLive(meeting, makeSegment("user-2", "Chronote hello"));

  expect(mockCreate).not.toHaveBeenCalled();
  expect(meeting.liveVoiceCommandPending?.userId).toBe("user-1");
});

test("expired pending command is cleared", async () => {
  const { maybeRespondLive } = await setupLiveVoice([]);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: "user-1",
    requestedAt: Date.now() - 60_000,
    expiresAt: Date.now() - 1,
  };

  await maybeRespondLive(meeting, makeSegment("user-1", "hello everyone"));

  expect(meeting.liveVoiceCommandPending).toBeUndefined();
});

test("drops pending and logs when confirmation prompt cannot enqueue", async () => {
  const { maybeRespondLive } = await setupLiveVoice([
    '{"action":"command_end"}',
  ]);

  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
    liveVoiceCommandsEnabled: true,
  });
  meeting.ttsQueue = {
    enqueue: jest.fn().mockReturnValue(false),
    playCueIfIdle: jest.fn().mockReturnValue(true),
    stopAndClear: jest.fn(),
    size: jest.fn().mockReturnValue(0),
  };

  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  await maybeRespondLive(
    meeting,
    makeSegment("user-1", "Chronote end meeting"),
  );

  expect(meeting.liveVoiceCommandPending).toBeUndefined();
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});

test("held live gate observes processing cancellation and cannot enqueue a late command", async () => {
  const { maybeRespondLive, mockCreate } = await setupLiveVoice([]);
  const lifetime = await import("../src/services/meetingProcessingLifetime");
  const meeting = makeMeeting({
    creatorId: "user-1",
    members: [{ id: "user-1", canEnd: true }],
  });
  let started!: () => void;
  const dispatched = new Promise<void>((done) => {
    started = done;
  });
  let complete!: (value: unknown) => void;
  mockCreate.mockImplementationOnce(() => {
    started();
    return new Promise((done) => {
      complete = done;
    });
  });
  const task = lifetime.runMeetingProcessingEffect(meeting, () =>
    maybeRespondLive(meeting, makeSegment("user-1", "Chronote end meeting")),
  );
  const result = task.catch(() => {});
  await dispatched;
  const options = mockCreate.mock.calls[0][1] as
    { signal?: AbortSignal } | undefined;
  expect(options?.signal?.aborted).toBe(false);
  let settled = false;
  const drain = lifetime.stopMeetingProcessing(meeting).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(options?.signal?.aborted).toBe(true);
  expect(settled).toBe(false);
  complete(completedResponse('{"action":"command_end"}'));
  await result;
  await drain;
  expect(meeting.ttsQueue?.enqueue).not.toHaveBeenCalled();
  expect(meeting.liveVoiceCommandPending).toBeUndefined();
});
