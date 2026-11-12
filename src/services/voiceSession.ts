import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild, VoiceBasedChannel } from "discord.js";

/** Joins and waits for Ready within the caller's signal. A join that is not Ready is torn down. */
export async function joinVoice(options: {
  voiceChannel: Pick<VoiceBasedChannel, "id">;
  guild: Pick<Guild, "id" | "voiceAdapterCreator">;
  captureAudio: boolean;
  signal: AbortSignal;
}): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId: options.voiceChannel.id,
    guildId: options.guild.id,
    adapterCreator: options.guild.voiceAdapterCreator,
    selfDeaf: !options.captureAudio,
    selfMute: false,
  });
  connection.on("daveResetSummary", (summary) => {
    console.info("DAVE reset readiness summary:", JSON.stringify(summary));
  });
  try {
    return await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      options.signal,
    );
  } catch (error) {
    leaveVoice(connection);
    throw error;
  }
}

function isDestroyed(connection: VoiceConnection): boolean {
  return connection.state.status === VoiceConnectionStatus.Destroyed;
}

/** Tells Discord the bot left the channel. */
export function leaveVoice(connection: VoiceConnection): void {
  if (!isDestroyed(connection)) connection.destroy();
}

/**
 * Tears the connection down without a voice state update, so a worker that
 * lost its lease cannot pull the new owner out of the channel.
 */
export function dropVoiceLocally(connection: VoiceConnection): void {
  if (!isDestroyed(connection)) connection.destroy(false);
}
