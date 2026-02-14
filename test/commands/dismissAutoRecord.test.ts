import type {
  Client,
  GuildMember,
  UserContextMenuCommandInteraction,
} from "discord.js";
import {
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { handleDismissAutoRecord } from "../../src/commands/dismissAutoRecord";
import { getMeeting } from "../../src/meetings";
import { resolveConfigEnum } from "../../src/services/unifiedConfigService";
import { handleEndMeetingOther } from "../../src/commands/endMeeting";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";

jest.mock("../../src/meetings", () => ({
  getMeeting: jest.fn(),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigEnum: jest.fn(),
}));
jest.mock("../../src/commands/endMeeting", () => ({
  handleEndMeetingOther: jest.fn(),
}));

const mockedGetMeeting = getMeeting as jest.MockedFunction<typeof getMeeting>;
const mockedResolveConfigEnum = resolveConfigEnum as jest.MockedFunction<
  typeof resolveConfigEnum
>;
const mockedHandleEndMeetingOther =
  handleEndMeetingOther as jest.MockedFunction<typeof handleEndMeetingOther>;

const makeClient = (botId = "bot-1"): Client =>
  ({ user: { id: botId } }) as Client;

const makeMember = (id: string, bot: boolean): GuildMember =>
  ({ id, user: { bot } }) as GuildMember;

const makeMembers = (entries: Array<[string, boolean]>) =>
  new Collection(entries.map(([id, bot]) => [id, makeMember(id, bot)]));

const makeVoiceChannel = (
  members: Collection<string, GuildMember>,
): MeetingData["voiceChannel"] =>
  ({ id: "voice-1", members }) as MeetingData["voiceChannel"];

const makeMeeting = (overrides: Partial<MeetingData> = {}): MeetingData =>
  ({
    guildId: "guild-1",
    isAutoRecording: true,
    finishing: false,
    voiceChannel: makeVoiceChannel(
      makeMembers([
        ["user-1", false],
        ["bot-1", true],
      ]),
    ),
    startTriggeredByUserId: "user-2",
    ...overrides,
  }) as MeetingData;

type InteractionOverrides = {
  inGuild?: () => boolean;
  guildId?: string;
  user?: { id: string };
  targetUser?: { id: string };
  memberPermissions?: PermissionsBitField;
  reply?: jest.Mock;
  deferReply?: jest.Mock;
  editReply?: jest.Mock;
};

const makeInteraction = (
  overrides: InteractionOverrides = {},
): UserContextMenuCommandInteraction =>
  ({
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    targetUser: { id: "bot-1" },
    memberPermissions: new PermissionsBitField(),
    reply: jest.fn().mockResolvedValue(undefined),
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as UserContextMenuCommandInteraction;

describe("handleDismissAutoRecord", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedHandleEndMeetingOther.mockResolvedValue(undefined);
  });

  it("blocks solo non-admins for trigger_or_admin when they did not trigger", async () => {
    const client = makeClient();
    const interaction = makeInteraction();
    const meeting = makeMeeting({
      voiceChannel: makeVoiceChannel(makeMembers([["user-1", false]])),
      startTriggeredByUserId: "user-2",
    });
    mockedGetMeeting.mockReturnValue(meeting);
    mockedResolveConfigEnum.mockResolvedValue("trigger_or_admin");

    await handleDismissAutoRecord(client, interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("do not have permission"),
      }),
    );
    expect(mockedHandleEndMeetingOther).not.toHaveBeenCalled();
  });

  it("allows solo users for solo_or_admin", async () => {
    const client = makeClient();
    const interaction = makeInteraction();
    const meeting = makeMeeting({
      voiceChannel: makeVoiceChannel(
        makeMembers([
          ["user-1", false],
          ["bot-1", true],
        ]),
      ),
    });
    mockedGetMeeting.mockReturnValue(meeting);
    mockedResolveConfigEnum.mockResolvedValue("solo_or_admin");

    await handleDismissAutoRecord(client, interaction);

    expect(mockedHandleEndMeetingOther).toHaveBeenCalledWith(client, meeting);
    expect(meeting.endReason).toBe(MEETING_END_REASONS.DISMISSED);
    expect(meeting.endTriggeredByUserId).toBe("user-1");
    expect(meeting.cancelled).toBe(true);
    expect(meeting.cancellationReason).toContain("<@user-1>");
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith("Stopped recording.");
  });

  it("allows the trigger user for trigger_or_admin", async () => {
    const client = makeClient();
    const interaction = makeInteraction();
    const meeting = makeMeeting({
      startTriggeredByUserId: "user-1",
      voiceChannel: makeVoiceChannel(
        makeMembers([
          ["user-1", false],
          ["user-2", false],
        ]),
      ),
    });
    mockedGetMeeting.mockReturnValue(meeting);
    mockedResolveConfigEnum.mockResolvedValue("trigger_or_admin");

    await handleDismissAutoRecord(client, interaction);

    expect(mockedHandleEndMeetingOther).toHaveBeenCalledWith(client, meeting);
  });

  it("allows anyone in channel when policy is anyone_in_channel", async () => {
    const client = makeClient();
    const interaction = makeInteraction();
    const meeting = makeMeeting({
      voiceChannel: makeVoiceChannel(
        makeMembers([
          ["user-1", false],
          ["user-2", false],
        ]),
      ),
    });
    mockedGetMeeting.mockReturnValue(meeting);
    mockedResolveConfigEnum.mockResolvedValue("anyone_in_channel");

    await handleDismissAutoRecord(client, interaction);

    expect(mockedHandleEndMeetingOther).toHaveBeenCalledWith(client, meeting);
  });

  it("allows admins regardless of policy", async () => {
    const client = makeClient();
    const interaction = makeInteraction({
      memberPermissions: new PermissionsBitField(
        PermissionFlagsBits.Administrator,
      ),
    });
    const meeting = makeMeeting({
      voiceChannel: makeVoiceChannel(
        makeMembers([
          ["user-1", false],
          ["user-2", false],
        ]),
      ),
    });
    mockedGetMeeting.mockReturnValue(meeting);
    mockedResolveConfigEnum.mockResolvedValue("trigger_or_admin");

    await handleDismissAutoRecord(client, interaction);

    expect(mockedHandleEndMeetingOther).toHaveBeenCalledWith(client, meeting);
  });
});
