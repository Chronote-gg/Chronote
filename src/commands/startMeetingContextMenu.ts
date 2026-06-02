import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type UserContextMenuCommandInteraction,
} from "discord.js";
import { handleRequestStartMeeting } from "./startMeeting";

export const START_MEETING_CONTEXT_COMMAND_NAME = "Start meeting";

export const startMeetingContextCommand = new ContextMenuCommandBuilder()
  .setName(START_MEETING_CONTEXT_COMMAND_NAME)
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

type TargetVoiceValidation =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      message: string;
      invokerVoiceChannelId?: string | null;
      targetVoiceChannelId?: string | null;
    };

const START_MEETING_CONTEXT_DM_ACK =
  "I sent you a DM with why Start meeting did not run.";

async function fetchGuildMember(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;

  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function validateTargetVoiceChannel(
  interaction: UserContextMenuCommandInteraction,
  botUserId: string,
): Promise<TargetVoiceValidation> {
  const guild = interaction.guild;
  if (!guild) {
    return {
      ok: false,
      reason: "missing-guild",
      message: "Start meeting can only be used in a server.",
    };
  }

  const invokerMember = await fetchGuildMember(guild, interaction.user.id);
  const invokerVoiceChannelId = invokerMember?.voice.channelId ?? null;
  if (!invokerVoiceChannelId) {
    return {
      ok: false,
      reason: "invoker-not-in-voice",
      message:
        "Join a voice channel, then use Start meeting on yourself, Chronote, or someone in that voice channel.",
      invokerVoiceChannelId,
    };
  }

  const targetUserId = interaction.targetUser.id;
  if (targetUserId === botUserId || targetUserId === interaction.user.id) {
    return { ok: true };
  }

  const targetMember = await fetchGuildMember(guild, targetUserId);
  const targetVoiceChannelId = targetMember?.voice.channelId ?? null;
  if (!targetVoiceChannelId) {
    return {
      ok: false,
      reason: "target-not-in-voice",
      message:
        "I did not start a meeting because the selected user is not in a voice channel. Use Start meeting on yourself, Chronote, or someone in your current voice channel.",
      invokerVoiceChannelId,
      targetVoiceChannelId,
    };
  }

  if (targetVoiceChannelId !== invokerVoiceChannelId) {
    return {
      ok: false,
      reason: "target-in-different-voice",
      message:
        "I did not start a meeting because the selected user is in a different voice channel. Use Start meeting on yourself, Chronote, or someone in your current voice channel.",
      invokerVoiceChannelId,
      targetVoiceChannelId,
    };
  }

  return { ok: true };
}

async function replyWithDmError(
  interaction: UserContextMenuCommandInteraction,
  validation: Exclude<TargetVoiceValidation, { ok: true }>,
) {
  console.log("Start meeting context menu blocked", {
    guildId: interaction.guildId,
    reason: validation.reason,
    invokerVoiceChannelId: validation.invokerVoiceChannelId,
    targetVoiceChannelId: validation.targetVoiceChannelId,
  });

  let dmSent = true;
  try {
    await interaction.user.send(validation.message);
  } catch (error) {
    dmSent = false;
    console.warn("Failed to DM Start meeting context menu error", {
      guildId: interaction.guildId,
      reason: validation.reason,
      error,
    });
  }

  await interaction.reply({
    content: dmSent ? START_MEETING_CONTEXT_DM_ACK : validation.message,
    ephemeral: true,
  });
}

export async function handleStartMeetingContextCommand(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
) {
  const botUserId = client.user?.id;
  if (!botUserId) {
    await interaction.reply({
      content: "The bot is still starting up. Try again in a moment.",
      ephemeral: true,
    });
    return;
  }

  const validation = await validateTargetVoiceChannel(interaction, botUserId);
  if (!validation.ok) {
    await replyWithDmError(interaction, validation);
    return;
  }

  await handleRequestStartMeeting(interaction, { ephemeralErrors: true });
}
