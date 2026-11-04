/** @jest-environment node */
import { createGuildVoiceOperationService } from "../../src/services/guildVoiceOperationService";
import { GatewayOpcodes } from "discord.js";
import {
  fixture,
  unknownVoiceState,
  leaves,
  flush,
  joinKnownSession,
  observeSettlement,
  holdNextVoiceWrite,
  loseNextWriteResponse,
  persistenceRow,
} from "../fixtures/guildVoiceOperation";
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: jest.fn(),
}));

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each([
  "none",
  "shardResume",
  "shardReconnecting",
  "shardReady",
  "shardDisconnect",
])(
  "sends exactly one gateway leave and settles on Discord's confirmation after %s",
  async (event) => {
    const f = fixture();
    await joinKnownSession(f);
    if (event === "shardDisconnect") f.client.emit(event, {}, 0);
    else if (event !== "none") f.client.emit(event, 0, 1);
    const settlement = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    expect(leaves(f)).toEqual([
      {
        op: GatewayOpcodes.VoiceStateUpdate,
        d: {
          guild_id: f.reservation.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        },
      },
    ]);
    f.packet(null, 2);
    expect(await settlement).toBe("settled");
    expect(f.storage.get()?.state).toBe("settled");
    expect(leaves(f)).toHaveLength(1);
  },
);

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
test.each(["stale-sequence", "wrong-session", "unknown-session"])(
  "leave confirmation needs no session or sequence match: %s",
  async (reason) => {
    const f = fixture();
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    if (reason !== "unknown-session") f.packet("channel", 3);
    const settlement = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    f.packet(
      null,
      reason === "stale-sequence" ? 2 : 4,
      reason === "wrong-session" ? "wrong" : "session",
    );
    expect(await settlement).toBe("settled");
    expect(f.storage.get()?.state).toBe("settled");
    expect(leaves(f)).toHaveLength(1);
  },
);
test.each(["wrong-shard", "wrong-guild", "other-user", "in-channel"])(
  "%s gateway packet cannot prove the leave",
  async (reason) => {
    jest.useFakeTimers();
    const f = fixture();
    await joinKnownSession(f);
    const settlement = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    f.client.emit(
      "raw",
      {
        t: "VOICE_STATE_UPDATE",
        d: {
          guild_id: reason === "wrong-guild" ? "other" : f.reservation.guildId,
          user_id: reason === "other-user" ? "human" : "bot",
          channel_id: reason === "in-channel" ? "channel" : null,
        },
      },
      reason === "wrong-shard" ? 1 : 0,
    );
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await settlement).toBe("uncertain");
    expect(leaves(f)).toHaveLength(1);
    expect(f.storage.get()?.state).toBe("uncertain");
  },
);
test.each([
  ["unknown-voice-state", "settled"],
  ["no-channel", "settled"],
  ["in-voice", "uncertain"],
  ["unavailable", "uncertain"],
] as const)(
  "REST fallback without a gateway confirmation: %s is %s",
  async (rest, outcome) => {
    jest.useFakeTimers();
    const f = fixture();
    f.fetchVoiceState.mockImplementation(async () => {
      if (rest === "unknown-voice-state") throw unknownVoiceState();
      if (rest === "unavailable") throw new Error("REST unavailable");
      return { channelId: rest === "in-voice" ? "channel" : null };
    });
    await joinKnownSession(f);
    const settlement = f.settleOwnedVoiceSession(f.reservation);
    await jest.advanceTimersByTimeAsync(3_499);
    expect(f.fetchVoiceState).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.fetchVoiceState).toHaveBeenCalledWith("@me", {
      force: true,
      cache: false,
    });
    await jest.advanceTimersByTimeAsync(1_501);
    expect(await settlement).toBe(outcome);
    expect(f.storage.get()?.state).toBe(outcome);
    expect(leaves(f)).toHaveLength(1);
  },
);
test("REST check that outlasts the deadline leaves the outcome uncertain", async () => {
  jest.useFakeTimers();
  const f = fixture();
  f.fetchVoiceState.mockImplementation(() => new Promise(() => {}));
  await joinKnownSession(f);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await settlement).toBe("uncertain");
  expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
    phase: "waiting",
    reason: "rest_check_timeout",
  });
});
test("lost voice ownership at settlement stays uncertain and is never settled later", async () => {
  jest.useFakeTimers();
  const f = fixture();
  await joinKnownSession(f);
  f.storage.set({ ...f.storage.get()!, ownerInstanceId: "newer" });
  const proof = observeSettlement(f);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(null, 2);
  expect(await settlement).toBe("uncertain");
  expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
    phase: "sealed",
    reason: "ownership_changed",
  });
  f.packet(null, 3);
  await f.waitOwnedVoiceEffects(f.reservation);
  expect(proof.settled).toBe(false);
  expect(f.storage.get()?.ownerInstanceId).toBe("newer");
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
  expect(leaves(f)).toHaveLength(1);
});
test("rejected leave send stays uncertain even after a later confirmation", async () => {
  jest.useFakeTimers();
  const f = fixture((payload) =>
    payload.d.channel_id === null
      ? Promise.reject(new Error("transport"))
      : Promise.resolve(),
  );
  await joinKnownSession(f);
  const proof = observeSettlement(f);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
  await flush();
  f.packet(null, 2);
  expect(await settlement).toBe("uncertain");
  expect(f.storage.get()?.state).toBe("uncertain");
  expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
    phase: "sealed",
    reason: "transport_rejected",
  });
  await flush();
  expect(proof.settled).toBe(false);
});
test("uncertain settlement keeps the guild owned locally", async () => {
  jest.useFakeTimers();
  const f = fixture();
  await joinKnownSession(f);
  const settlement = f.settleOwnedVoiceSession(f.reservation);
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
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await settlement).toBe("uncertain");
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
  expect(leaves(f)).toHaveLength(1);
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

test.each(["held-leave", "rejected-leave", "aborted-held-leave"])(
  "%s remains fenced after a later matching ACK",
  async (reason) => {
    jest.useFakeTimers();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture((payload) => {
      if (payload.d.channel_id !== null) return Promise.resolve();
      if (reason === "held-leave" || reason === "aborted-held-leave")
        return held;
      if (reason === "rejected-leave")
        return Promise.reject(new Error("transport"));
      return Promise.resolve();
    });
    await joinKnownSession(f);
    const settlement = observeSettlement(f);
    const caller = new AbortController();
    const disposition = f.settleOwnedVoiceSession(f.reservation, {
      signal: caller.signal,
    });
    await flush();
    if (reason === "aborted-held-leave") caller.abort();
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await disposition).toBe("uncertain");
    finish();
    f.packet(null, 3);
    await f.waitOwnedVoiceEffects(f.reservation);
    await flush();
    expect(settlement.settled).toBe(false);
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
    expect(f.client.listenerCount("raw")).toBe(0);
    expect(f.sendPayload).toHaveBeenCalledTimes(2);
  },
);

test.each(
  [
    "other-channel",
    "changed-session",
    "stale-sequence",
    "shard-reconnect",
    "shard-resume",
    "shard-disconnect",
  ].flatMap((event) => [
    { event, timing: "during" },
    { event, timing: "after" },
  ]),
)(
  "$event $timing the proof wait cannot stop a later confirmation from settling",
  async ({ event, timing }) => {
    jest.useFakeTimers();
    const f = fixture();
    await joinKnownSession(f);
    const proof = observeSettlement(f);
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    if (timing === "after") await jest.advanceTimersByTimeAsync(5_001);
    if (event === "other-channel") f.packet("other", 2);
    if (event === "changed-session") f.packet("channel", 2, "different");
    if (event === "stale-sequence") f.packet("channel", 1);
    if (event === "shard-reconnect") f.client.emit("shardReconnecting", 0);
    if (event === "shard-resume") f.client.emit("shardResume", 0, 1);
    if (event === "shard-disconnect") f.client.emit("shardDisconnect", {}, 0);
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await disposition).toBe("uncertain");
    f.packet(null, 3);
    await proof.promise;
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("settled");
    expect(f.storage.get()?.state).toBe("settled");
    expect(f.client.listenerCount("raw")).toBe(0);
    expect(leaves(f)).toHaveLength(1);
  },
);

test("status before leave cannot turn an unissued leave into an ACK", async () => {
  jest.useFakeTimers();
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
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  expect(settled).toBe(false);
  expect(f.sendPayload).toHaveBeenCalledTimes(2);
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
  loseNextWriteResponse(f);
  await joinKnownSession(f);
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
      if (reason !== "unchanged") f.storage.set(persistenceRow(row, reason));
      if (reason === "missing") f.storage.set(undefined);
      if (reason === "unknown")
        f.getRecord.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    await joinKnownSession(f);
    const settlement = observeSettlement(f);
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    f.packet(null, 2);
    expect(await disposition).toBe("uncertain");
    await f.waitOwnedVoiceEffects(f.reservation);
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe("uncertain");
    expect(settlement.settled).toBe(false);
    expect(f.writeVoice).toHaveBeenCalledTimes(1);
    expect(f.client.listenerCount("raw")).toBe(0);
  },
);

test("confirmed uncertain write with lost response does not poison the late settlement chain", async () => {
  jest.useFakeTimers();
  const f = fixture();
  loseNextWriteResponse(f);
  await joinKnownSession(f);
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
  await joinKnownSession(f);
  const settlement = observeSettlement(f);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  await f.waitOwnedVoiceEffects(f.reservation);
  expect(settlement.settled).toBe(false);
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
  expect(f.getRecord).toHaveBeenCalledTimes(1);
});

test.each([
  ["gateway", "settled", "gateway_leave"],
  ["rest-not-in-voice", "settled", "rest_not_in_voice"],
  ["rest-in-voice", "waiting", "rest_in_voice"],
  ["rest-unavailable", "waiting", "rest_unavailable"],
  ["late-gateway", "settled", "late_gateway_leave"],
])(
  "%s proof route produces a content-free settlement log",
  async (route, phase, reason) => {
    jest.useFakeTimers();
    const f = fixture();
    if (route === "rest-not-in-voice")
      f.fetchVoiceState.mockRejectedValue(unknownVoiceState());
    if (route === "rest-in-voice")
      f.fetchVoiceState.mockResolvedValue({ channelId: "channel" });
    await joinKnownSession(f);
    const disposition = f.settleOwnedVoiceSession(f.reservation);
    await flush();
    if (route === "gateway") f.packet(null, 2);
    await jest.advanceTimersByTimeAsync(5_001);
    await disposition;
    if (route === "late-gateway") {
      f.packet(null, 2);
      await f.whenOwnedVoiceSettled(f.reservation);
    }
    expect(console.info).toHaveBeenCalledWith("Owned voice settlement", {
      phase,
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
  const f = fixture();
  const finish = holdNextVoiceWrite(f);
  await joinKnownSession(f);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  const proof = observeSettlement(f);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await disposition).toBe("uncertain");
  f.packet(null, 2);
  await flush();
  expect(proof.settled).toBe(false);
  expect(f.writeVoice).toHaveBeenCalledTimes(1);
  finish();
  await proof.promise;
  expect(f.storage.get()?.state).toBe("settled");
  expect(f.writeVoice).toHaveBeenCalledTimes(2);
});

test("shard resume while durable settlement is held does not revoke the proof", async () => {
  const f = fixture();
  const finish = holdNextVoiceWrite(f);
  await joinKnownSession(f);
  const disposition = f.settleOwnedVoiceSession(f.reservation);
  const proof = observeSettlement(f);
  await flush();
  f.packet(null, 2);
  await flush();
  f.client.emit("shardResume", 0, 1);
  finish();
  expect(await disposition).toBe("settled");
  await proof.promise;
  expect(f.storage.get()?.state).toBe("settled");
  expect(f.client.listenerCount("raw")).toBe(0);
});

test("effect draining called at a late ACK includes its newly queued durable write", async () => {
  jest.useFakeTimers();
  const { promise: held, resolve: finish } = Promise.withResolvers<void>();
  const f = fixture();
  const write = f.writeVoice.getMockImplementation()!;
  f.writeVoice.mockImplementation(async (...args) => {
    if (args[0].state === "settled") await held;
    return write(...args);
  });
  await joinKnownSession(f);
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

test.each(["join", "leave", "ack"])(
  "shortened preservation budget during %s keeps the exact send boundary",
  async (phase) => {
    jest.useFakeTimers();
    const { createPreservationBudget } =
      await import("../../src/services/preservationBudget");
    let finish!: () => void;
    const transport = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture((payload) => {
      const leave = payload.d.channel_id === null;
      return (phase === "join" && !leave) || (phase === "leave" && leave)
        ? transport
        : Promise.resolve();
    });
    await f.joinOwnedVoiceSession(f.reservation, f.options);
    f.packet("channel", 1);
    const budget = createPreservationBudget(Date.now() + 10000);
    let proven = false;
    void f.whenOwnedVoiceSettled(f.reservation).then(() => {
      proven = true;
    });
    const disposition = f.settleOwnedVoiceSession(f.reservation, {
      deadline: budget.deadline,
      signal: budget.signal,
    });
    await flush();
    budget.shorten(Date.now() + 100);
    await jest.advanceTimersByTimeAsync(100);
    expect(budget.signal.aborted).toBe(true);
    expect(await disposition).toBe("uncertain");
    expect(proven).toBe(false);
    finish();
    await flush();
    f.packet(null, 2);
    await f.waitOwnedVoiceEffects(f.reservation);
    await flush();
    expect(proven).toBe(phase === "ack");
    expect(f.sendPayload).toHaveBeenCalledTimes(phase === "join" ? 1 : 2);
    expect(await f.settleOwnedVoiceSession(f.reservation)).toBe(
      phase === "ack" ? "settled" : "uncertain",
    );
    budget.dispose();
  },
);
