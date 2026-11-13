import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

type SentPayload = { op: number; d: { channel_id: string | null } };

let nextGuildId = 200000000000000001n;

/**
 * A guild whose gateway adapter records what the real voice library sends,
 * so a join (a channel id) and a leave (`null`) can be told apart.
 */
export function fakeVoiceGuild() {
  const sent: SentPayload[] = [];
  const voiceAdapterCreator: DiscordGatewayAdapterCreator = () => ({
    sendPayload(payload) {
      sent.push(payload);
      return true;
    },
    destroy() {},
  });
  const id = String(nextGuildId++);
  return {
    guild: { id, voiceAdapterCreator },
    sent,
    channelIds: () => sent.map((payload) => payload.d.channel_id),
  };
}
