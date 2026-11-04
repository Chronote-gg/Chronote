import { createGuildVoiceOperationService } from "../../src/services/guildVoiceOperationService";
import { randomUUID } from "node:crypto";
import {
  DiscordAPIError,
  GatewayOpcodes,
  type VoiceBasedChannel,
  type GatewaySendPayload,
} from "discord.js";
import { createVoiceGuild } from "./voiceSession";
import type {
  SessionReservation,
  VoiceRecord,
} from "../../src/types/deploymentControl";
import type { DeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";

export function fixture(send?: (payload: GatewaySendPayload) => Promise<void>) {
  const guildId = randomUUID();
  const { client, guild, fetchVoiceState } = createVoiceGuild(guildId);
  const reservation: SessionReservation = {
    guildId,
    meetingId: "meeting",
    sessionMode: "tts_only",
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: randomUUID(),
    reservedAt: 100,
    workHandle: { settle: jest.fn(), transition: jest.fn() },
  };
  let stored: VoiceRecord | undefined = {
    pk: `VOICE#${guildId}`,
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId,
    meetingId: reservation.meetingId,
    ownerInstanceId: reservation.ownerInstanceId,
    attemptId: reservation.voiceOperationAttemptId,
    executionVersion: 1,
    sessionMode: "tts_only",
    state: "joining",
    updatedAt: 100,
  };
  const writeVoice = jest.fn<
    ReturnType<DeploymentControlRepository["writeVoice"]>,
    Parameters<DeploymentControlRepository["writeVoice"]>
  >(async (next, expected) => {
    if (
      !stored ||
      stored.attemptId !== expected?.attemptId ||
      stored.ownerInstanceId !== expected.ownerInstanceId ||
      stored.meetingId !== expected.meetingId ||
      stored.state !== expected.state
    )
      return "stale";
    stored = next;
    return "applied";
  });
  const getRecord = jest.fn<
    ReturnType<DeploymentControlRepository["getRecord"]>,
    Parameters<DeploymentControlRepository["getRecord"]>
  >(async () => stored);
  const sendPayload = jest.fn(
    async (_shardId: number, payload: GatewaySendPayload) => {
      if (send) await send(payload);
    },
  );
  const service = createGuildVoiceOperationService(
    { writeVoice, getRecord },
    () => sendPayload,
  );
  const options = {
    guild,
    voiceChannel: { id: "channel" } as VoiceBasedChannel,
    captureAudio: false,
    signal: new AbortController().signal,
  };
  const packet = (
    channelId: string | null,
    sequence = 2,
    sessionId = "session",
    shardId = 0,
  ) =>
    client.emit(
      "raw",
      {
        t: "VOICE_STATE_UPDATE",
        s: sequence,
        d: {
          guild_id: guildId,
          user_id: "bot",
          session_id: sessionId,
          channel_id: channelId,
        },
      },
      shardId,
    );
  return {
    ...service,
    options,
    reservation,
    packet,
    client,
    fetchVoiceState,
    sendPayload,
    writeVoice,
    getRecord,
    storage: {
      get: () => stored,
      set: (row: VoiceRecord | undefined) => {
        stored = row;
      },
    },
  };
}
export function unknownVoiceState() {
  return new DiscordAPIError(
    { code: 10065, message: "Unknown Voice State" },
    10065,
    404,
    "GET",
    "/guilds/guild/voice-states/@me",
    {},
  );
}
export function leaves(f: ReturnType<typeof fixture>) {
  return f.sendPayload.mock.calls
    .map(([, payload]) => payload)
    .filter(
      (payload) =>
        payload.op === GatewayOpcodes.VoiceStateUpdate &&
        payload.d.channel_id === null,
    );
}
export async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
export async function joinKnownSession(f: ReturnType<typeof fixture>) {
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
}
export function observeSettlement(f: ReturnType<typeof fixture>) {
  let settled = false;
  const promise = f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
  };
}
export function holdNextVoiceWrite(f: ReturnType<typeof fixture>) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const write = f.writeVoice.getMockImplementation()!;
  f.writeVoice.mockImplementationOnce(async (...args) => {
    await promise;
    return write(...args);
  });
  return resolve;
}
export function loseNextWriteResponse(f: ReturnType<typeof fixture>) {
  f.writeVoice.mockImplementationOnce(async (row) => {
    f.storage.set(row);
    throw new Error("response lost");
  });
}
export function persistenceRow(row: VoiceRecord, reason: string): VoiceRecord {
  const changes: Record<string, Partial<VoiceRecord>> = {
    "old-settled": { updatedAt: row.updatedAt - 1 },
    "other-attempt": { attemptId: "different" },
    "other-owner": { ownerInstanceId: "different" },
    "other-meeting": { meetingId: "different" },
    "other-execution": { executionVersion: 2 },
    "other-mode": { sessionMode: "meeting" },
  };
  return { ...row, ...changes[reason] };
}
