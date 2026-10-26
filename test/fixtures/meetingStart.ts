import { mockNotesDestinations } from "./notesDestinationConfig";
import {
  ChannelType,
  Client,
  ClientUser,
  Guild,
  GuildMember,
  Message,
  PermissionsBitField,
  TextChannel,
  User,
  VoiceChannel,
  VoiceState,
} from "discord.js";
import {
  getGuildLimits,
  getLimitsForTier,
} from "../../src/services/subscriptionService";

import { initializeMeeting } from "../../src/meetings";
import { checkBotPermissions } from "../../src/utils/permissions";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("../../src/meetings", () => ({
  hasMeeting: jest.fn(() => false),
  getMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  initializeMeeting: jest.fn(),
}));
jest.mock("../../src/commands/endMeeting", () => ({
  handleEndMeetingOther: jest.fn(),
  persistExplicitMeetingStop: jest.fn(),
}));
jest.mock("../../src/services/meetingVoiceSettingsService", () => ({
  resolveMeetingVoiceSettings: jest.fn(async () => ({})),
}));
jest.mock("../../src/services/meetingArtifactAccessService", () => ({
  resolveServerMeetingArtifactAccess: jest.fn(async () => ({
    transcriptAccessEnabled: false,
  })),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  ...jest.requireActual("../../src/services/activeMeetingLeaseService"),
  getActiveMeetingLeaseForGuild: jest.fn(async () => undefined),
  isLeaseActive: (lease: { leaseExpiresAt: number }) =>
    lease.leaseExpiresAt > Date.now() / 1000,
}));
jest.mock("../../src/services/subscriptionService", () => ({
  ...jest.requireActual("../../src/services/subscriptionService"),
  getGuildLimits: jest.fn(),
}));
jest.mock("../../src/utils/permissions", () => ({
  checkBotPermissions: jest.fn(() => ({ success: true })),
  canBotSendMessages: jest.fn(() => true),
}));
jest.mock("../../src/services/ownedMeetingInterruption", () => ({
  ...jest.requireActual("../../src/services/ownedMeetingInterruption"),
  interruptOwnedMeeting: jest.fn(async () => ({ kind: "unresolved" })),
}));

export function mockFreeGuildLimits(
  maxMeetingMinutesRolling = getLimitsForTier("free").maxMeetingMinutesRolling,
) {
  jest.mocked(getGuildLimits).mockResolvedValue({
    limits: { ...getLimitsForTier("free"), maxMeetingMinutesRolling },
    subscription: {
      tier: "free",
      status: "active",
      source: "default",
      billingSource: "free",
      stripeTier: null,
      grantTier: null,
      activeGrant: null,
    },
  });
}

export function createMeetingStartDiscordFixture() {
  const client = new Client({ intents: [] });
  const guild: Guild = Reflect.construct(Guild, [client, { id: "guild-1" }]);
  const creator: User = Reflect.construct(User, [
    client,
    { id: "user-1", username: "Starter" },
  ]);
  const bot: ClientUser = Reflect.construct(ClientUser, [
    client,
    { id: "bot-1", username: "Chronote" },
  ]);
  client.user = bot;
  const member: GuildMember = Reflect.construct(GuildMember, [
    client,
    { user: { id: creator.id, username: creator.username }, roles: [] },
    guild,
  ]);
  const botMember: GuildMember = Reflect.construct(GuildMember, [
    client,
    { user: { id: bot.id, username: bot.username }, roles: [] },
    guild,
  ]);
  const voice: VoiceChannel = Reflect.construct(VoiceChannel, [
    guild,
    {
      id: "voice-1",
      type: ChannelType.GuildVoice,
      name: "Voice",
      bitrate: 64000,
    },
    client,
  ]);
  const notes: TextChannel = Reflect.construct(TextChannel, [
    guild,
    { id: "voice-notes", type: ChannelType.GuildText, name: "private-notes" },
    client,
  ]);
  function cacheVoiceMember() {
    client.guilds.cache.set(guild.id, guild);
    guild.channels.cache.set(voice.id, voice);
    guild.members.cache.set(creator.id, member);
    guild.members.cache.set(bot.id, botMember);
    guild.voiceStates.cache.set(
      creator.id,
      Reflect.construct(VoiceState, [
        guild,
        { user_id: creator.id, channel_id: voice.id },
      ]),
    );
    jest.spyOn(client.users, "fetch").mockResolvedValue(creator);
  }
  function resetStart({
    published,
    notesPermissions,
    selectDestination,
  }: {
    published: Message;
    notesPermissions: bigint[];
    selectDestination: (scope: string) => string | undefined;
  }) {
    cacheVoiceMember();
    const fetchChannel = jest
      .spyOn(guild.channels, "fetch")
      .mockResolvedValue(notes);
    const send = jest.spyOn(notes, "send").mockResolvedValue(published);
    jest
      .spyOn(notes, "permissionsFor")
      .mockReturnValue(new PermissionsBitField(notesPermissions));
    jest.mocked(checkBotPermissions).mockReturnValue({ success: true });
    mockNotesDestinations(selectDestination);
    mockFreeGuildLimits(0);
    jest.mocked(initializeMeeting).mockResolvedValue({
      guildId: guild.id,
      meetingId: "meeting-1",
      voiceChannel: voice,
      textChannel: notes,
      startTime: new Date("2026-10-16T00:00:00Z"),
    } as MeetingData);
    return { fetchChannel, send };
  }
  return {
    client,
    guild,
    creator,
    bot,
    member,
    botMember,
    voice,
    notes,
    resetStart,
  };
}
