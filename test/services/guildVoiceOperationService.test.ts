/** @jest-environment node */
import { createGuildVoiceOperationService } from "../../src/services/guildVoiceOperationService";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Guild, VoiceBasedChannel, GatewaySendPayload } from "discord.js";
import type { SessionReservation } from "../../src/types/deploymentControl";
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: jest.fn(),
}));

function fixture(send?: (payload: GatewaySendPayload) => Promise<void>) {
  const guildId = randomUUID();
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
  const writeVoice = jest.fn(async () => "applied" as const);
  const sendPayload = jest.fn(
    async (_shardId: number, payload: GatewaySendPayload) => {
      if (send) await send(payload);
    },
  );
  const service = createGuildVoiceOperationService(
    { writeVoice },
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
    sendPayload,
    writeVoice,
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("logs only aggregate DAVE readiness summaries from the owned connection", async () => {
  const f = fixture();
  const log = jest.spyOn(console, "info").mockImplementation(() => {});
  const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
  const summary = [
    {
      reason: "initial",
      outcome: "ready",
      ageBucket: "under-100ms",
      count: 2,
    },
  ];
  connection.emit("daveResetSummary", summary);
  expect(log.mock.calls).toEqual([
    ["DAVE reset readiness summary:", JSON.stringify(summary)],
  ]);
  connection.destroy(false);
});

test("settles only after known matching gateway leave and closes the actual SDK connection", async () => {
  const f = fixture();
  const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(null, 2);
  expect(await settlement).toBe("settled");
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
  expect(connection.state.status).toBe("destroyed");
  expect(f.writeVoice.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "settled",
  });
  expect(connection.rejoin()).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
});
test.each([
  "stale-sequence",
  "wrong-session",
  "resume",
  "disconnect",
  "wrong-shard",
  "unknown-session",
])("%s cannot prove voice settlement", async (reason) => {
  jest.useFakeTimers();
  const f = fixture();
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  if (reason !== "unknown-session") f.packet("channel", 3);
  if (reason === "resume") f.client.emit("shardResume", 0, 1);
  if (reason === "disconnect") f.client.emit("shardDisconnect", {}, 0);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(
    null,
    reason === "stale-sequence" ? 2 : 4,
    reason === "wrong-session" ? "wrong" : "session",
    reason === "wrong-shard" ? 1 : 0,
  );
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await settlement).toBe("uncertain");
  expect(f.writeVoice.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "uncertain",
  });
  await expect(
    f.joinOwnedVoiceSession(f.reservation, f.options),
  ).rejects.toThrow("already owned");
});
test("held queued send blocks leave; timeout never schedules late cleanup or clears guard", async () => {
  jest.useFakeTimers();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => pending);
  const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await settlement).toBe("uncertain");
  finish();
  await flush();
  expect(connection.rejoin()).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
  expect(f.writeVoice.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "uncertain",
  });
});
test("reservation with no attempted external send can settle without a gateway event", async () => {
  const f = fixture();
  f.prepareOwnedVoiceSession(f.reservation);
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
  expect(f.sendPayload).not.toHaveBeenCalled();
});

test("caller abort after send drain wins before final leave continuation", async () => {
  const f = fixture();
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  await flush();
  f.packet("channel", 1);
  const caller = new AbortController();
  const settlement = f.settleOwnedVoiceSession(f.reservation, {
    signal: caller.signal,
  });
  queueMicrotask(() => caller.abort());
  expect(await settlement).toBe("uncertain");
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
});

test("held send completes before the sole leave and only a later gateway event settles", async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture((payload) =>
    payload.d.channel_id === null ? Promise.resolve() : pending,
  );
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
  finish();
  await flush();
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
  expect(f.sendPayload.mock.calls[1][1].d.channel_id).toBeNull();
  f.packet(null, 2);
  expect(await settlement).toBe("settled");
});

test("a leave event before the queued join completes cannot acknowledge final leave", async () => {
  jest.useFakeTimers();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => pending);
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  f.packet(null, 2);
  finish();
  await flush();
  expect(await settlement).toBe("uncertain");
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
});

test("missingTaskDoesNotSettleVoice: no local operation cannot manufacture proof", async () => {
  const write = jest.fn(async () => "applied" as const);
  const service = createGuildVoiceOperationService({ writeVoice: write });
  const reservation = {
    guildId: "guild",
    meetingId: "meeting",
    sessionMode: "tts_only" as const,
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "attempt",
    reservedAt: 100,
    workHandle: { settle: jest.fn(), transition: jest.fn() },
  };
  expect(await service.settleOwnedVoiceSession(reservation)).toBe("uncertain");
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({ state: "uncertain" }),
    expect.objectContaining({ attemptId: "attempt" }),
  );
  expect(reservation.workHandle.settle).not.toHaveBeenCalled();
});

test("bounded voice uncertainty does not settle an issued transport promise", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => pending);
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation, {
    deadline: Date.now() + 100,
  });
  let effectsSettled = false;
  const effects = f.waitOwnedVoiceEffects(f.reservation).then(() => {
    effectsSettled = true;
  });
  await jest.advanceTimersByTimeAsync(100);
  expect(await disposition).toBe("uncertain");
  expect(effectsSettled).toBe(false);
  finish();
  await effects;
  expect(effectsSettled).toBe(true);
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
  expect(f.reservation.workHandle.settle).not.toHaveBeenCalled();
});
