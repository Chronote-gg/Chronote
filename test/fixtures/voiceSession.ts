import { EventEmitter } from "node:events";
import type { Guild, VoiceState } from "discord.js";
import type { DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";

export function createVoiceGuild(guildId: string) {
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" } });
  const fetchVoiceState = jest.fn<Promise<Pick<VoiceState, "channelId">>, []>(
    async () => {
      throw new Error("voice state unavailable");
    },
  );
  const guild = {
    id: guildId,
    shardId: 0,
    client,
    voiceStates: { fetch: fetchVoiceState },
    // Mirrors discord.js ClientVoiceManager, which destroys adapters on shard disconnect.
    voiceAdapterCreator: (methods: DiscordGatewayAdapterLibraryMethods) => {
      client.on("shardDisconnect", (_event: unknown, shardId: number) => {
        if (shardId === 0) methods.destroy();
      });
      return { sendPayload: () => true, destroy: jest.fn() };
    },
  } as unknown as Guild;
  return { client, guild, fetchVoiceState };
}

export function createSettledReservationVoiceMock() {
  return {
    whenOwnedVoiceSettled: jest.fn(async () => {}),
    prepareOwnedVoiceSession: jest.fn(),
    settleOwnedVoiceSession: jest.fn(async () => "settled"),
  };
}
