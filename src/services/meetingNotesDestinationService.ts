import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { CONFIG_KEYS } from "../config/keys";
import {
  getSnapshotString,
  resolveConfigSnapshot,
} from "./unifiedConfigService";

const DESTINATION_ERROR =
  "The notes channel is unavailable. Choose an accessible text channel or ask a server admin to check the notes destination.";

export async function resolveMeetingNotesChannel(input: {
  guild: Guild;
  voiceChannelId: string;
  explicitChannelId?: string;
  invocationChannelId?: string;
}): Promise<TextChannel> {
  try {
    const configuredChannelId =
      input.explicitChannelId ??
      getSnapshotString(
        await resolveConfigSnapshot(
          { guildId: input.guild.id, channelId: input.voiceChannelId },
          { strict: true },
        ),
        CONFIG_KEYS.notes.channelId,
        { trim: true },
      );
    const channelId = configuredChannelId ?? input.invocationChannelId;
    if (!channelId) throw new Error(DESTINATION_ERROR);
    const channel = await input.guild.channels.fetch(channelId);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guild.id !== input.guild.id
    ) {
      throw new Error(DESTINATION_ERROR);
    }
    return channel;
  } catch {
    throw new Error(DESTINATION_ERROR);
  }
}

export function assertMemberCanAccessNotesChannel(
  member: GuildMember,
  channel: TextChannel,
): void {
  try {
    const permissions = channel.permissionsFor(member);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    ) {
      throw new Error(DESTINATION_ERROR);
    }
  } catch {
    throw new Error(DESTINATION_ERROR);
  }
}
