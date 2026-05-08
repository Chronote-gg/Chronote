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

const makeClient = (botId: string | null = "bot-1"): Client =>
  ({ user: botId ? { id: botId } : null }) as Client;

const makeInteraction = (targetUserId = "bot-1") =>
  ({
    targetUser: { id: targetUserId },
    reply: jest.fn().mockResolvedValue(undefined),
  }) as unknown as UserContextMenuCommandInteraction;

describe("start meeting context menu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedHandleRequestStartMeeting.mockResolvedValue(undefined);
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

  it("blocks invocations on users other than Chronote", async () => {
    const interaction = makeInteraction("user-1");

    await handleStartMeetingContextCommand(makeClient("bot-1"), interaction);

    expect(mockedHandleRequestStartMeeting).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Right-click <@bot-1> to start a meeting.",
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
