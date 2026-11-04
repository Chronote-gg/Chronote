import { EventEmitter } from "node:events";
import type { Guild } from "discord.js";

export function createVoiceGuild(guildId: string) {
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" } });
  const guild = {
    id: guildId,
    shardId: 0,
    client,
    voiceAdapterCreator: () => ({
      sendPayload: () => true,
      destroy: jest.fn(),
    }),
  } as unknown as Guild;
  return { client, guild };
}

export function createSettledReservationVoiceMock() {
  return {
    whenOwnedVoiceSettled: jest.fn(async () => {}),
    prepareOwnedVoiceSession: jest.fn(),
    settleOwnedVoiceSession: jest.fn(async () => "settled"),
  };
}
