import type { Client, UserContextMenuCommandInteraction } from "discord.js";
import { ApplicationCommandType } from "discord.js";
import { handleRequestStartMeeting } from "../../src/commands/startMeeting";
import {
  START_MEETING_CONTEXT_COMMAND_NAME,
  handleStartMeetingContextCommand,
  startMeetingContextCommand,
} from "../../src/commands/startMeetingContextMenu";

jest.mock("../../src/commands/startMeeting", () => ({
  handleRequestStartMeeting: jest.fn(),
}));

const mockedHandleRequestStartMeeting =
  handleRequestStartMeeting as jest.MockedFunction<
    typeof handleRequestStartMeeting
  >;

type MockGuildMember = {
  voice: { channelId: string | null };
};

type MockInteraction = UserContextMenuCommandInteraction & {
  reply: jest.Mock;
  user: { id: string; send: jest.Mock };
};

const makeClient = (botId: string | null = "bot-1"): Client =>
  ({ user: botId ? { id: botId } : null }) as Client;

const makeMember = (voiceChannelId: string | null): MockGuildMember => ({
  voice: { channelId: voiceChannelId },
});

const makeGuild = (members: Record<string, MockGuildMember>) => {
  const cache = new Map(Object.entries(members));
  return {
    id: "guild-1",
    members: {
      cache,
      fetch: jest.fn(async (userId: string) => {
        const member = cache.get(userId);
        if (!member) throw new Error("Member not found");
        return member;
      }),
    },
  };
};

const makeInteraction = (
  targetUserId = "bot-1",
  userId = "user-1",
  members: Record<string, MockGuildMember> = {
    "user-1": makeMember("voice-1"),
    "bot-1": makeMember(null),
  },
) =>
  ({
    guildId: "guild-1",
    guild: makeGuild(members),
    user: { id: userId, send: jest.fn().mockResolvedValue(undefined) },
    targetUser: { id: targetUserId },
    reply: jest.fn().mockResolvedValue(undefined),
  }) as unknown as MockInteraction;

describe("start meeting context menu", () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockedHandleRequestStartMeeting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("registers a guild-only user context menu command", () => {
    expect(startMeetingContextCommand.toJSON()).toEqual(
      expect.objectContaining({
        name: START_MEETING_CONTEXT_COMMAND_NAME,
        type: ApplicationCommandType.User,
        dm_permission: false,
      }),
    );
  });

  it("starts a meeting when invoked on Chronote", async () => {
    const interaction = makeInteraction("bot-1");

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).toHaveBeenCalledWith(interaction, {
      ephemeralErrors: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("starts a meeting when invoked on yourself", async () => {
    const interaction = makeInteraction("user-1", "user-1");

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).toHaveBeenCalledWith(interaction, {
      ephemeralErrors: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("starts a meeting when invoked on someone in the same voice channel", async () => {
    const interaction = makeInteraction("user-2", "user-1", {
      "user-1": makeMember("voice-1"),
      "user-2": makeMember("voice-1"),
      "bot-1": makeMember(null),
    });

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).toHaveBeenCalledWith(interaction, {
      ephemeralErrors: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("DMs when invoked on someone in a different voice channel", async () => {
    const interaction = makeInteraction("user-2", "user-1", {
      "user-1": makeMember("voice-1"),
      "user-2": makeMember("voice-2"),
      "bot-1": makeMember(null),
    });

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.user.send).toHaveBeenCalledWith(
      "I did not start a meeting because the selected user is in a different voice channel. Use Start meeting on yourself, Chronote, or someone in your current voice channel.",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "I sent you a DM with why Start meeting did not run.",
      ephemeral: true,
    });
  });

  it("DMs when invoked on someone outside voice", async () => {
    const interaction = makeInteraction("user-2", "user-1", {
      "user-1": makeMember("voice-1"),
      "user-2": makeMember(null),
      "bot-1": makeMember(null),
    });

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.user.send).toHaveBeenCalledWith(
      "I did not start a meeting because the selected user is not in a voice channel. Use Start meeting on yourself, Chronote, or someone in your current voice channel.",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "I sent you a DM with why Start meeting did not run.",
      ephemeral: true,
    });
  });

  it("falls back to an ephemeral reply when the DM fails", async () => {
    const interaction = makeInteraction("user-2", "user-1", {
      "user-1": makeMember("voice-1"),
      "user-2": makeMember("voice-2"),
      "bot-1": makeMember(null),
    });
    interaction.user.send.mockRejectedValue(new Error("DM disabled"));

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content:
        "I did not start a meeting because the selected user is in a different voice channel. Use Start meeting on yourself, Chronote, or someone in your current voice channel.",
      ephemeral: true,
    });
  });

  it("DMs when the invoker is not in a voice channel", async () => {
    const interaction = makeInteraction("bot-1", "user-1", {
      "user-1": makeMember(null),
      "bot-1": makeMember(null),
    });

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.user.send).toHaveBeenCalledWith(
      "Join a voice channel, then use Start meeting on yourself, Chronote, or someone in that voice channel.",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "I sent you a DM with why Start meeting did not run.",
      ephemeral: true,
    });
  });

  it("blocks while the bot user is unavailable", async () => {
    const interaction = makeInteraction("bot-1");

    await handleStartMeetingContextCommand(makeClient(null), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "The bot is still starting up. Try again in a moment.",
      ephemeral: true,
    });
  });
});
