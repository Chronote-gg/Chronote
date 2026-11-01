/** @jest-environment node */
import { createGuildVoiceOperationService } from "../../src/services/guildVoiceOperationService";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Guild, VoiceBasedChannel, GatewaySendPayload } from "discord.js";
import type {
  SessionReservation,
  VoiceRecord,
} from "../../src/types/deploymentControl";
import type { DeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
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
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
});
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
  const service = createGuildVoiceOperationService({
    writeVoice: write,
    getRecord: jest.fn(async () => undefined),
  });
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
  expect(write).not.toHaveBeenCalled();
  expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
    phase: "refused",
    reason: "missing_operation",
  });
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

test("same-session status between sole leave and ACK does not invalidate settlement", async () => {
  const f = fixture();
  const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet("channel", 2);
  f.packet(null, 3);
  expect(await settlement).toBe("settled");
  expect(connection.rejoin()).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
  expect(f.client.listenerCount("raw")).toBe(0);
});

test("late ACK resolves one shared durable proof without changing the first disposition", async () => {
  jest.useFakeTimers();
  const f = fixture();
  const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const proof = f.whenOwnedVoiceSettled(f.reservation);
  expect(f.whenOwnedVoiceSettled(f.reservation)).toBe(proof);
  let completions = 0;
  void proof.then(() => completions++);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await settlement).toBe("uncertain");
  await f.waitOwnedVoiceEffects(f.reservation);
  expect(completions).toBe(0);
  expect(f.client.listenerCount("raw")).toBe(1);
  f.packet("channel", 2);
  f.packet(null, 3);
  await proof;
  expect(completions).toBe(1);
  expect(f.whenOwnedVoiceSettled(f.reservation)).toBe(proof);
  expect(await settlement).toBe("uncertain");
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
  expect(f.storage.get()?.state).toBe("settled");
  expect(f.client.listenerCount("raw")).toBe(0);
  expect(f.client.listenerCount("shardResume")).toBe(0);
  expect(connection.rejoin()).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
  f.packet(null, 4);
  await flush();
  expect(completions).toBe(1);
  expect(f.writeVoice).toHaveBeenCalledTimes(2);
});

test("ACK while the leave transport is held cannot resolve proof before its completion", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture((payload) =>
    payload.d.channel_id === null ? held : Promise.resolve(),
  );
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  let settled = false;
  const proof = f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(null, 2);
  await flush();
  expect(settled).toBe(false);
  expect(f.storage.get()?.state).toBe("joining");
  finish();
  expect(await disposition).toBe("settled");
  await proof;
  expect(settled).toBe(true);
});

test.each([
  "held-leave",
  "rejected-leave",
  "other-channel",
  "changed-session",
  "stale-sequence",
  "shard-reconnect",
  "aborted",
])("%s remains fenced after a later matching ACK", async (reason) => {
  jest.useFakeTimers();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture((payload) => {
    if (payload.d.channel_id !== null) return Promise.resolve();
    if (reason === "held-leave") return held;
    if (reason === "rejected-leave")
      return Promise.reject(new Error("transport"));
    return Promise.resolve();
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  let settled = false;
  void f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  const caller = new AbortController();
  const disposition = f.settleOwnedVoiceSession(f.reservation, {
    signal: caller.signal,
  });
  await flush();
  if (reason === "other-channel") f.packet("other", 2);
  if (reason === "changed-session") f.packet("channel", 2, "different");
  if (reason === "stale-sequence") f.packet("channel", 1);
  if (reason === "shard-reconnect") f.client.emit("shardReconnecting", 0);
  if (reason === "aborted") caller.abort();
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  finish();
  f.packet(null, 3);
  await f.waitOwnedVoiceEffects(f.reservation);
  await flush();
  expect(settled).toBe(false);
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
  expect(f.client.listenerCount("raw")).toBe(0);
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
});

test("status before leave cannot turn an unissued leave into an ACK", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => held);
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  let settled = false;
  void f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  f.packet("channel", 2);
  f.packet(null, 3);
  finish();
  expect(await disposition).toBe("uncertain");
  expect(settled).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(1);
});

test.each(["foreign-owner", "copied-reservation"])(
  "%s cannot seal or subscribe to the original operation",
  async (reason) => {
    const f = fixture();
    const connection = await f.joinOwnedVoiceSession(f.reservation, f.options);
    f.packet("channel", 1);
    const foreign = {
      ...f.reservation,
      ...(reason === "foreign-owner" ? { ownerInstanceId: "foreign" } : {}),
    };
    let foreignSettled = false;
    void f.whenOwnedVoiceSettled(foreign).then(() => {
      foreignSettled = true;
    });
    expect(await f.settleOwnedVoiceSession(foreign)).toBe("uncertain");
    expect(connection.state.status).not.toBe("destroyed");
    expect(f.writeVoice).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
      phase: "refused",
      reason: "foreign_operation",
    });
    const original = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    f.packet(null, 2);
    expect(await original).toBe("settled");
    expect(foreignSettled).toBe(false);
  },
);

test("remote settled row without a local operation cannot produce proof", async () => {
  const f = fixture();
  f.storage.set({ ...f.storage.get()!, state: "settled" });
  let settled = false;
  void f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
  await flush();
  expect(settled).toBe(false);
  expect(f.getRecord).not.toHaveBeenCalled();
});

test("lost settlement write acknowledgment is proved by exact strong readback", async () => {
  const f = fixture();
  f.writeVoice.mockImplementationOnce(async (row) => {
    f.storage.set(row);
    throw new Error("response lost");
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(null, 2);
  expect(await disposition).toBe("settled");
  await f.whenOwnedVoiceSettled(f.reservation);
  expect(f.getRecord).toHaveBeenCalledWith(
    `VOICE#${f.reservation.guildId}`,
    "STATE",
  );
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
});

test.each([
  "unchanged",
  "old-settled",
  "other-attempt",
  "other-owner",
  "other-meeting",
  "other-execution",
  "other-mode",
  "missing",
  "unknown",
  "stale",
])(
  "%s persistence evidence cannot prove requested durable settlement",
  async (reason) => {
    const f = fixture();
    f.writeVoice.mockImplementationOnce(async (row) => {
      if (reason === "stale") return "stale";
      if (reason !== "unchanged") {
        f.storage.set({
          ...row,
          ...(reason === "old-settled" ? { updatedAt: row.updatedAt - 1 } : {}),
          ...(reason === "other-attempt" ? { attemptId: "different" } : {}),
          ...(reason === "other-owner" ? { ownerInstanceId: "different" } : {}),
          ...(reason === "other-meeting" ? { meetingId: "different" } : {}),
          ...(reason === "other-execution" ? { executionVersion: 2 } : {}),
          ...(reason === "other-mode"
            ? { sessionMode: "meeting" as const }
            : {}),
        });
      }
      if (reason === "missing") f.storage.set(undefined);
      if (reason === "unknown")
        f.getRecord.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    f.packet("channel", 1);
    let settled = false;
    void f.whenOwnedVoiceSettled(f.reservation).then(() => {
      settled = true;
    });
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    f.packet(null, 2);
    expect(await disposition).toBe("uncertain");
    await f.waitOwnedVoiceEffects(f.reservation);
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
    expect(settled).toBe(false);
    expect(f.writeVoice).toHaveBeenCalledTimes(1);
    expect(f.client.listenerCount("raw")).toBe(0);
  },
);

test("confirmed uncertain write with lost response does not poison the late settlement chain", async () => {
  jest.useFakeTimers();
  const f = fixture();
  f.writeVoice.mockImplementationOnce(async (row) => {
    f.storage.set(row);
    throw new Error("response lost");
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  await f.whenOwnedVoiceSettled(f.reservation);
  expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
  expect(f.writeVoice).toHaveBeenCalledTimes(2);
  expect(f.writeVoice.mock.calls[1][1]).toMatchObject({ state: "uncertain" });
});

test.each(["write", "readback"])(
  "held %s preserves bounded disposition and tracks actual durable proof",
  async (phase) => {
    jest.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.writeVoice.mockImplementationOnce(async (row) => {
      if (phase === "write") await held;
      f.storage.set(row);
      if (phase === "readback") throw new Error("response lost");
      return "applied";
    });
    if (phase === "readback")
      f.getRecord.mockImplementationOnce(async () => {
        await held;
        return f.storage.get();
      });
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    f.packet("channel", 1);
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    let result: string | undefined;
    void disposition.then((value) => {
      result = value;
    });
    let proved = false;
    const proof = f.whenOwnedVoiceSettled(f.reservation).then(() => {
      proved = true;
    });
    let drained = false;
    const effects = f.waitOwnedVoiceEffects(f.reservation).then(() => {
      drained = true;
    });
    await flush();
    f.packet(null, 2);
    await jest.advanceTimersByTimeAsync(5_001);
    expect(result).toBe("uncertain");
    expect(proved).toBe(false);
    expect(drained).toBe(false);
    finish();
    await effects;
    await proof;
    expect(proved).toBe(true);
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
    expect(f.writeVoice).toHaveBeenCalledTimes(1);
  },
);

test("unproved uncertain write is not replayed or followed by settlement on late ACK", async () => {
  jest.useFakeTimers();
  const f = fixture();
  f.writeVoice.mockRejectedValueOnce(new Error("write response lost"));
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  let settled = false;
  void f.whenOwnedVoiceSettled(f.reservation).then(() => {
    settled = true;
  });
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  await f.waitOwnedVoiceEffects(f.reservation);
  expect(settled).toBe(false);
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
  expect(f.getRecord).toHaveBeenCalledTimes(1);
});

test.each([
  ["unknown-session", "session_unknown"],
  ["wrong-session", "session_changed"],
  ["wrong-channel", "channel_changed"],
  ["before-leave", "leave_not_issued"],
])(
  "%s produces a content-free reason for the held operation",
  async (event, reason) => {
    jest.useFakeTimers();
    const f = fixture();
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    if (event !== "unknown-session") f.packet("channel", 1);
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    if (event !== "before-leave") await flush();
    f.packet(
      event === "wrong-channel" ? "other" : null,
      2,
      event === "wrong-session" ? "different" : "session",
    );
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await disposition).toBe("uncertain");
    expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
      phase: "sealed",
      reason,
    });
    for (const args of jest.mocked(console.info).mock.calls) {
      expect(args[1]).toEqual({
        phase: expect.any(String),
        reason: expect.any(String),
      });
    }
  },
);

test("late ACK waits for the held uncertain write before its single settled transition", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture();
  const write = f.writeVoice.getMockImplementation()!;
  f.writeVoice.mockImplementationOnce(async (...args) => {
    await held;
    return write(...args);
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  let proved = false;
  const proof = f.whenOwnedVoiceSettled(f.reservation).then(() => {
    proved = true;
  });
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  await flush();
  expect(proved).toBe(false);
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
  finish();
  await proof;
  expect(f.storage.get()?.state).toBe("settled");
  expect(f.writeVoice).toHaveBeenCalledTimes(2);
});

test("shard loss while durable settlement is held cannot publish local proof", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture();
  const write = f.writeVoice.getMockImplementation()!;
  f.writeVoice.mockImplementationOnce(async (...args) => {
    await held;
    return write(...args);
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  let proved = false;
  void f.whenOwnedVoiceSettled(f.reservation).then(() => {
    proved = true;
  });
  await flush();
  f.packet(null, 2);
  await flush();
  f.client.emit("shardResume", 0, 1);
  finish();
  expect(await disposition).toBe("uncertain");
  expect(proved).toBe(false);
  expect(f.client.listenerCount("raw")).toBe(0);
  await expect(
    f.joinOwnedVoiceSession(f.reservation, f.options),
  ).rejects.toThrow("already owned");
});

test.each(["wrong-session", "wrong-channel", "stale-sequence", "shard-loss"])(
  "%s after an ACK-only timeout removes passive observation without releasing ownership",
  async (reason) => {
    jest.useFakeTimers();
    const f = fixture();
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    f.packet("channel", 1);
    let proved = false;
    void f.whenOwnedVoiceSettled(f.reservation).then(() => {
      proved = true;
    });
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await disposition).toBe("uncertain");
    if (reason === "shard-loss") f.client.emit("shardReconnecting", 0);
    else
      f.packet(
        reason === "wrong-channel" ? "other" : null,
        reason === "stale-sequence" ? 1 : 2,
        reason === "wrong-session" ? "different" : "session",
      );
    f.packet(null, 3);
    await f.waitOwnedVoiceEffects(f.reservation);
    expect(proved).toBe(false);
    expect(f.client.listenerCount("raw")).toBe(0);
    expect(f.writeVoice).toHaveBeenCalledTimes(1);
    expect(f.sendPayload).toHaveBeenCalledTimes(2);
  },
);

test("effect draining called at a late ACK includes its newly queued durable write", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture();
  const write = f.writeVoice.getMockImplementation()!;
  f.writeVoice.mockImplementation(async (...args) => {
    if (args[0].state === "settled") await held;
    return write(...args);
  });
  await f.joinOwnedVoiceSession(f.reservation, f.options);
  f.packet("channel", 1);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  let drained = false;
  const effects = f.waitOwnedVoiceEffects(f.reservation).then(() => {
    drained = true;
  });
  await flush();
  expect(f.writeVoice).toHaveBeenCalledTimes(2);
  expect(drained).toBe(false);
  finish();
  await effects;
  await f.whenOwnedVoiceSettled(f.reservation);
});
