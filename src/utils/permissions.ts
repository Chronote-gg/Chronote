import {
  GuildMember,
  type PermissionResolvable,
  PermissionsBitField,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";

type RequiredPermission = {
  flag: PermissionResolvable;
  label: string;
};

type MissingMeetingPermissionSummary = {
  voiceChannelName: string;
  textChannelName: string;
  missingVoicePermissions: string[];
  missingTextPermissions: string[];
};

const VOICE_CHANNEL_MEETING_PERMISSIONS = [
  { flag: PermissionsBitField.Flags.ViewChannel, label: "View Channel" },
  { flag: PermissionsBitField.Flags.Connect, label: "Connect" },
] satisfies RequiredPermission[];

const TEXT_CHANNEL_MEETING_PERMISSIONS = [
  { flag: PermissionsBitField.Flags.ViewChannel, label: "View Channel" },
  { flag: PermissionsBitField.Flags.SendMessages, label: "Send Messages" },
  {
    flag: PermissionsBitField.Flags.ReadMessageHistory,
    label: "Read Message History",
  },
  { flag: PermissionsBitField.Flags.EmbedLinks, label: "Embed Links" },
] satisfies RequiredPermission[];

const getMissingPermissions = (
  permissions: Readonly<PermissionsBitField> | null,
  requiredPermissions: RequiredPermission[],
) => {
  if (!permissions) {
    return requiredPermissions.map((permission) => permission.label);
  }

  return requiredPermissions
    .filter((permission) => !permissions.has(permission.flag))
    .map((permission) => permission.label);
};

export const formatMissingPermissions = (permissions: string[]) =>
  permissions.map((permission) => `**${permission}**`).join(", ");

export const formatMissingMeetingPermissions = ({
  voiceChannelName,
  textChannelName,
  missingVoicePermissions,
  missingTextPermissions,
}: MissingMeetingPermissionSummary): string => {
  const parts: string[] = [];
  if (missingVoicePermissions.length > 0) {
    parts.push(
      `voice channel **${voiceChannelName}**: ${formatMissingPermissions(missingVoicePermissions)}`,
    );
  }
  if (missingTextPermissions.length > 0) {
    parts.push(
      `notes channel **${textChannelName}**: ${formatMissingPermissions(missingTextPermissions)}`,
    );
  }
  if (parts.length === 0) {
    return "one or more channels (permissions may have just been updated)";
  }
  return parts.join("; ");
};

export const buildAutoRecordPermissionChannelMessage = (
  summary: MissingMeetingPermissionSummary,
) =>
  `Cannot start auto-recording because Chronote is missing permissions in ${formatMissingMeetingPermissions(summary)}.`;

export const buildAutoRecordPermissionDmMessage = (
  summary: MissingMeetingPermissionSummary & { isAdmin: boolean },
) => {
  if (summary.isAdmin) {
    return `${buildAutoRecordPermissionChannelMessage(summary)} Grant those permissions, then have everyone leave and rejoin the voice channel to trigger auto-record again.`;
  }

  return "Chronote tried to auto-record when you joined voice, but it cannot post meeting status or notes in the configured notes channel. A server admin needs to grant Chronote View Channel, Send Messages, Read Message History, and Embed Links in the notes channel, plus View Channel and Connect in the voice channel. If you expected this meeting to record, please ask an admin to check Chronote's channel permissions.";
};

/**
 * Checks if the bot has permission to join a voice channel
 * @param voiceChannel - The voice channel to check
 * @param botMember - The bot's guild member object
 * @returns true if bot can join, false otherwise
 */
export function canBotJoinVoiceChannel(
  voiceChannel: VoiceBasedChannel,
  botMember: GuildMember,
): boolean {
  return (
    getMissingVoiceChannelPermissions(voiceChannel, botMember).length === 0
  );
}

export function getMissingVoiceChannelPermissions(
  voiceChannel: VoiceBasedChannel,
  botMember: GuildMember,
): string[] {
  return getMissingPermissions(
    voiceChannel.permissionsFor(botMember),
    VOICE_CHANNEL_MEETING_PERMISSIONS,
  );
}

/**
 * Checks if the bot has permission to send messages in a text channel
 * @param textChannel - The text channel to check
 * @param botMember - The bot's guild member object
 * @returns true if bot can send messages, false otherwise
 */
export function canBotSendMessages(
  textChannel: TextChannel,
  botMember: GuildMember,
): boolean {
  const permissions = textChannel.permissionsFor(botMember);
  return !!(
    permissions &&
    permissions.has(PermissionsBitField.Flags.SendMessages) &&
    permissions.has(PermissionsBitField.Flags.ViewChannel)
  );
}

export function getMissingMeetingTextChannelPermissions(
  textChannel: TextChannel,
  botMember: GuildMember,
): string[] {
  return getMissingPermissions(
    textChannel.permissionsFor(botMember),
    TEXT_CHANNEL_MEETING_PERMISSIONS,
  );
}

export interface PermissionCheckResult {
  success: boolean;
  errorMessage?: string;
}

/**
 * Performs a comprehensive permission check for both voice and text channels
 * @param voiceChannel - The voice channel to check
 * @param textChannel - The text channel to check
 * @param botMember - The bot's guild member object
 * @returns Result object with success status and optional error message
 */
export function checkBotPermissions(
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
  botMember: GuildMember,
): PermissionCheckResult {
  const missingVoicePermissions = getMissingVoiceChannelPermissions(
    voiceChannel,
    botMember,
  );
  if (missingVoicePermissions.length > 0) {
    return {
      success: false,
      errorMessage: `I am missing ${formatMissingPermissions(missingVoicePermissions)} in **${voiceChannel.name}**.`,
    };
  }

  const missingTextPermissions = getMissingMeetingTextChannelPermissions(
    textChannel,
    botMember,
  );
  if (missingTextPermissions.length > 0) {
    return {
      success: false,
      errorMessage: `I am missing ${formatMissingPermissions(missingTextPermissions)} in **${textChannel.name}**.`,
    };
  }

  return { success: true };
}
