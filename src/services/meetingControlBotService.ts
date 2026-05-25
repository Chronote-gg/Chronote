import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type TextChannel,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { getMeeting } from "../meetings";
import {
  buildManualMeetingStartedMessage,
  startManualMeetingFromChannels,
} from "../commands/startMeeting";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
  requestMeetingEndViaLease,
} from "./activeMeetingLeaseService";
import { getGuildLimits } from "./subscriptionService";
import {
  getSnapshotString,
  resolveConfigSnapshot,
} from "./unifiedConfigService";
import { CONFIG_KEYS } from "../config/keys";
import { buildLiveMeetingTimelineEvents } from "./meetingTimelineService";
import {
  MEETING_CONTROL_COMMAND_TYPES,
  type LiveMeetingCommandInput,
  type MeetingControlCommand,
  type MeetingControlCommandResult,
  type StartMeetingCommandInput,
  type StopMeetingCommandInput,
} from "../types/meetingControl";
import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  MEETING_STATUS,
  resolveMeetingStatus,
} from "../types/meetingLifecycle";
import { canGuildMemberEndMeeting } from "../utils/meetingPermissions";
import type { ActiveMeetingLease } from "../types/db";
import type { MeetingData } from "../types/meeting-data";

const DEFAULT_TRANSCRIPT_EVENT_LIMIT = 50;
const MAX_TRANSCRIPT_EVENT_LIMIT = 200;

class MeetingControlExecutionError extends Error {}

type ResolvedLiveMeeting =
  | { guildId: string; meeting: MeetingData }
  | { guildId: string; lease: ActiveMeetingLease };

const getGuildOrThrow = async (client: Client, guildId: string) => {
  const guild =
    client.guilds.cache.get(guildId) ??
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    throw new MeetingControlExecutionError("Chronote is not in that server.");
  }
  return guild;
};

const fetchVoiceState = async (guild: Guild, userId: string) => {
  const cached = guild.voiceStates.cache.get(userId);
  if (cached?.channelId) return cached;
  return guild.voiceStates.fetch(userId).catch(() => null);
};

const findUserVoiceStates = async (
  client: Client,
  userId: string,
  guildId?: string,
): Promise<VoiceState[]> => {
  if (guildId) {
    const guild = await getGuildOrThrow(client, guildId);
    const state = await fetchVoiceState(guild, userId);
    return state?.channelId ? [state] : [];
  }

  const cachedStates = client.guilds.cache
    .map((guild) => guild.voiceStates.cache.get(userId))
    .filter((state): state is VoiceState => Boolean(state?.channelId));
  if (cachedStates.length > 0) return cachedStates;

  const fetchedStates = await Promise.all(
    client.guilds.cache.map((guild) => fetchVoiceState(guild, userId)),
  );
  return fetchedStates.filter((state): state is VoiceState =>
    Boolean(state?.channelId),
  );
};

const resolveUserVoiceState = async (
  client: Client,
  userId: string,
  input:
    | StartMeetingCommandInput
    | StopMeetingCommandInput
    | LiveMeetingCommandInput,
) => {
  const states = await findUserVoiceStates(client, userId, input.serverId);
  if (states.length === 0) {
    throw new MeetingControlExecutionError(
      "Join a Discord voice channel first, then retry.",
    );
  }
  if (states.length > 1) {
    throw new MeetingControlExecutionError(
      "You are connected to multiple voice channels. Provide serverId.",
    );
  }
  return states[0];
};

const fetchVoiceChannel = async (guild: Guild, voiceChannelId: string) => {
  const channel = await guild.channels.fetch(voiceChannelId).catch(() => null);
  if (!channel?.isVoiceBased()) {
    throw new MeetingControlExecutionError("Voice channel not found.");
  }
  return channel as VoiceBasedChannel;
};

const fetchTextChannel = async (guild: Guild, textChannelId: string) => {
  const channel = await guild.channels.fetch(textChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new MeetingControlExecutionError("Text channel not found.");
  }
  return channel as TextChannel;
};

const resolveDefaultTextChannelId = async (guild: Guild) => {
  const { subscription } = await getGuildLimits(guild.id);
  const snapshot = await resolveConfigSnapshot({
    guildId: guild.id,
    tier: subscription.tier,
  });
  return getSnapshotString(snapshot, CONFIG_KEYS.notes.channelId, {
    trim: true,
  });
};

const resolveTextChannel = async (
  guild: Guild,
  input: StartMeetingCommandInput,
) => {
  const textChannelId =
    input.textChannelId ?? (await resolveDefaultTextChannelId(guild));
  if (!textChannelId) {
    throw new MeetingControlExecutionError(
      "Set a default notes channel or pass textChannelId.",
    );
  }
  return fetchTextChannel(guild, textChannelId);
};

const fetchMember = async (guild: Guild, userId: string) =>
  guild.members.cache.get(userId) ??
  (await guild.members.fetch(userId).catch(() => null));

const assertGuildMember: (
  member: GuildMember | null,
) => asserts member is GuildMember = (member) => {
  if (!member) {
    throw new MeetingControlExecutionError("Meeting access required.");
  }
};

const assertMemberCanUseTextChannel = (
  member: GuildMember | null,
  textChannel: TextChannel,
) => {
  assertGuildMember(member);
  const permissions = textChannel.permissionsFor(member);
  if (
    !permissions ||
    !permissions.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages)
  ) {
    throw new MeetingControlExecutionError(
      "You do not have permission to use the requested text channel.",
    );
  }
};

const assertMemberCanAccessLiveChannels = (
  member: GuildMember | null,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
) => {
  assertGuildMember(member);
  const voicePermissions = voiceChannel.permissionsFor(member);
  const textPermissions = textChannel.permissionsFor(member);
  if (
    !voicePermissions ||
    !voicePermissions.has(PermissionFlagsBits.ViewChannel) ||
    !voicePermissions.has(PermissionFlagsBits.Connect) ||
    !textPermissions ||
    !textPermissions.has(PermissionFlagsBits.ViewChannel) ||
    !textPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    throw new MeetingControlExecutionError("Meeting access required.");
  }
};

const assertSameVoiceChannel = (
  state: VoiceState,
  voiceChannel: VoiceBasedChannel,
) => {
  if (state.channelId !== voiceChannel.id) {
    throw new MeetingControlExecutionError(
      "Join the requested voice channel before starting a meeting.",
    );
  }
};

const executeStartMeeting = async (
  client: Client,
  userId: string,
  input: StartMeetingCommandInput,
): Promise<MeetingControlCommandResult> => {
  const state = await resolveUserVoiceState(client, userId, input);
  const guild = state.guild;
  const voiceChannel = input.voiceChannelId
    ? await fetchVoiceChannel(guild, input.voiceChannelId)
    : state.channel;
  if (!voiceChannel) {
    throw new MeetingControlExecutionError("Voice channel not found.");
  }
  assertSameVoiceChannel(state, voiceChannel);

  const textChannel = await resolveTextChannel(guild, input);
  const member = await fetchMember(guild, userId);
  assertMemberCanUseTextChannel(member, textChannel);
  const creator = await client.users.fetch(userId);
  const startResult = await startManualMeetingFromChannels({
    client,
    guild,
    voiceChannel,
    textChannel,
    creator,
    meetingContext: input.context,
    tags: input.tags,
    startReason: MEETING_START_REASONS.MCP,
    startTriggeredByUserId: userId,
  });
  if (!startResult.ok) {
    throw new MeetingControlExecutionError(startResult.error);
  }

  const message = await textChannel.send(
    buildManualMeetingStartedMessage(
      startResult.meeting,
      startResult.liveMeetingUrl,
    ),
  );
  startResult.meeting.startMessageId = message.id;

  return {
    status: "started",
    serverId: guild.id,
    meetingId: startResult.meeting.meetingId,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    textChannelId: textChannel.id,
    startedAt: startResult.meeting.startTime.toISOString(),
    liveUrl: startResult.liveMeetingUrl ?? undefined,
  };
};

const canMemberEndLease = (
  member: GuildMember | null,
  userId: string,
  startTriggeredByUserId?: string,
) => startTriggeredByUserId === userId || canGuildMemberEndMeeting(member);

const executeStopMeeting = async (
  client: Client,
  userId: string,
  input: StopMeetingCommandInput,
): Promise<MeetingControlCommandResult> => {
  const state = input.serverId
    ? undefined
    : await resolveUserVoiceState(client, userId, input);
  const guildId = input.serverId ?? state?.guild.id;
  if (!guildId) {
    throw new MeetingControlExecutionError("serverId is required.");
  }
  const guild = await getGuildOrThrow(client, guildId);
  const meeting = getMeeting(guildId);
  if (meeting) {
    if (input.meetingId && meeting.meetingId !== input.meetingId) {
      throw new MeetingControlExecutionError("Meeting not found.");
    }
    const member = await fetchMember(guild, userId);
    if (
      meeting.creator.id !== userId &&
      !canMemberEndLease(member, userId, meeting.startTriggeredByUserId)
    ) {
      throw new MeetingControlExecutionError(
        "You do not have permission to end this meeting.",
      );
    }
    if (meeting.finishing || meeting.finished) {
      return {
        status: "stopping",
        serverId: guildId,
        meetingId: meeting.meetingId,
      };
    }
    meeting.endReason = MEETING_END_REASONS.MCP;
    meeting.endTriggeredByUserId = userId;
    if (!meeting.onEndMeeting) {
      throw new MeetingControlExecutionError(
        "End meeting handler unavailable.",
      );
    }
    await meeting.onEndMeeting(meeting);
    return { status: "ended", serverId: guildId, meetingId: meeting.meetingId };
  }

  const lease = await getActiveMeetingLeaseForGuild(guildId);
  if (!lease || !isLeaseActive(lease)) {
    throw new MeetingControlExecutionError("Meeting not found.");
  }
  if (input.meetingId && lease.meetingId !== input.meetingId) {
    throw new MeetingControlExecutionError("Meeting not found.");
  }
  const member = await fetchMember(guild, userId);
  if (!canMemberEndLease(member, userId, lease.startTriggeredByUserId)) {
    throw new MeetingControlExecutionError(
      "You do not have permission to end this meeting.",
    );
  }
  const queued = await requestMeetingEndViaLease(
    guildId,
    lease.meetingId,
    userId,
    MEETING_END_REASONS.MCP,
  );
  if (!queued) {
    throw new MeetingControlExecutionError("Meeting end request was rejected.");
  }
  return { status: "stopping", serverId: guildId, meetingId: lease.meetingId };
};

const resolveLiveMeeting = async (
  client: Client,
  userId: string,
  input: LiveMeetingCommandInput,
): Promise<ResolvedLiveMeeting> => {
  const state = input.serverId
    ? undefined
    : await resolveUserVoiceState(client, userId, input);
  const guildId = input.serverId ?? state?.guild.id;
  if (!guildId) {
    throw new MeetingControlExecutionError("serverId is required.");
  }
  const guild = state?.guild ?? (await getGuildOrThrow(client, guildId));
  const member = await fetchMember(guild, userId);
  const meeting = getMeeting(guildId);
  if (meeting && (!input.meetingId || meeting.meetingId === input.meetingId)) {
    assertMemberCanAccessLiveChannels(
      member,
      meeting.voiceChannel,
      meeting.textChannel,
    );
    return { guildId, meeting };
  }
  const lease = await getActiveMeetingLeaseForGuild(guildId);
  if (
    !lease ||
    !isLeaseActive(lease) ||
    (input.meetingId && lease.meetingId !== input.meetingId)
  ) {
    throw new MeetingControlExecutionError("Meeting not found.");
  }
  const voiceChannel = await fetchVoiceChannel(guild, lease.voiceChannelId);
  const textChannel = await fetchTextChannel(guild, lease.textChannelId);
  assertMemberCanAccessLiveChannels(member, voiceChannel, textChannel);
  return { guildId, lease };
};

const executeGetLiveStatus = async (
  client: Client,
  userId: string,
  input: LiveMeetingCommandInput,
): Promise<MeetingControlCommandResult> => {
  const live = await resolveLiveMeeting(client, userId, input);
  if ("meeting" in live) {
    const meetingStatus = resolveMeetingStatus({
      cancelled: live.meeting.cancelled,
      finished: live.meeting.finished,
      finishing: live.meeting.finishing,
    });
    return {
      status: meetingStatus,
      serverId: live.guildId,
      meetingId: live.meeting.meetingId,
      voiceChannelId: live.meeting.voiceChannel.id,
      voiceChannelName: live.meeting.voiceChannel.name,
      textChannelId: live.meeting.textChannel.id,
      startedAt: live.meeting.startTime.toISOString(),
      endedAt: live.meeting.endTime?.toISOString(),
      isAutoRecording: live.meeting.isAutoRecording,
    };
  }
  return {
    status: isLeaseActive(live.lease)
      ? (live.lease.status ?? MEETING_STATUS.IN_PROGRESS)
      : MEETING_STATUS.COMPLETE,
    serverId: live.guildId,
    meetingId: live.lease.meetingId,
    voiceChannelId: live.lease.voiceChannelId,
    voiceChannelName: live.lease.voiceChannelName,
    textChannelId: live.lease.textChannelId,
    startedAt: live.lease.createdAt,
    endedAt: live.lease.endedAt,
    isAutoRecording: live.lease.isAutoRecording,
  };
};

const executeGetLiveTranscript = async (
  client: Client,
  userId: string,
  input: LiveMeetingCommandInput,
): Promise<MeetingControlCommandResult> => {
  const live = await resolveLiveMeeting(client, userId, input);
  if (!("meeting" in live)) {
    throw new MeetingControlExecutionError(
      "Live transcript is only available on the meeting owner runtime.",
    );
  }
  const allEvents = buildLiveMeetingTimelineEvents(live.meeting).filter(
    (event) =>
      (event.type === "voice" ||
        event.type === "tts" ||
        event.type === "bot") &&
      event.text.trim().length > 0,
  );
  const startIndex = input.afterEventId
    ? allEvents.findIndex((event) => event.id === input.afterEventId) + 1
    : 0;
  const safeStartIndex = Math.max(0, startIndex);
  const limit = Math.min(
    MAX_TRANSCRIPT_EVENT_LIMIT,
    Math.max(1, input.limit ?? DEFAULT_TRANSCRIPT_EVENT_LIMIT),
  );
  const events = allEvents.slice(safeStartIndex, safeStartIndex + limit);
  const nextEvent = events.at(-1);
  const hasMore = safeStartIndex + events.length < allEvents.length;
  return {
    serverId: live.guildId,
    meetingId: live.meeting.meetingId,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      time: event.time,
      speaker: event.speaker,
      text: event.text,
    })),
    hasMore,
    nextAfterEventId: hasMore ? nextEvent?.id : undefined,
  };
};

export async function executeMeetingControlCommand(
  client: Client,
  command: MeetingControlCommand,
): Promise<MeetingControlCommandResult> {
  switch (command.commandType) {
    case MEETING_CONTROL_COMMAND_TYPES.START_MEETING:
      return executeStartMeeting(
        client,
        command.userId,
        command.input as StartMeetingCommandInput,
      );
    case MEETING_CONTROL_COMMAND_TYPES.STOP_MEETING:
      return executeStopMeeting(
        client,
        command.userId,
        command.input as StopMeetingCommandInput,
      );
    case MEETING_CONTROL_COMMAND_TYPES.GET_LIVE_STATUS:
      return executeGetLiveStatus(
        client,
        command.userId,
        command.input as LiveMeetingCommandInput,
      );
    case MEETING_CONTROL_COMMAND_TYPES.GET_LIVE_TRANSCRIPT:
      return executeGetLiveTranscript(
        client,
        command.userId,
        command.input as LiveMeetingCommandInput,
      );
  }
}
