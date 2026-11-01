import { isDeepStrictEqual } from "node:util";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { z } from "zod";
import {
  SimpleShardingStrategy,
  type Client,
  type GatewaySendPayload,
} from "discord.js";
import type { MeetingInitOptions } from "../meetings";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import type {
  SessionReservation,
  VoiceRecord,
} from "../types/deploymentControl";
import { getDeploymentControlRepository } from "../db";

export type OwnedVoiceJoinOptions = Pick<
  MeetingInitOptions,
  "voiceChannel" | "guild" | "captureAudio"
> & { signal: AbortSignal };
export type VoiceSettlementOptions = {
  deadline?: number;
  signal?: AbortSignal;
};
const SETTLEMENT_TIMEOUT_MS = 5_000;
const voiceDispatch = z.object({
  t: z.literal("VOICE_STATE_UPDATE"),
  s: z.number().int(),
  d: z.object({
    guild_id: z.string(),
    user_id: z.string(),
    session_id: z.string().min(1),
    channel_id: z.string().nullable(),
  }),
});
type Operation = {
  reservation: SessionReservation;
  state: VoiceRecord["state"];
  closed: boolean;
  attempted: boolean;
  ambiguous: boolean;
  session?: string;
  sequence?: number;
  closeSequence?: number;
  acknowledged: boolean;
  leaveIssued: boolean;
  connection?: VoiceConnection;
  cleanup(): void;
  acknowledge(): void;
  acknowledgment: Promise<void>;
  resolveSettled(): void;
  writes: Promise<void>;
  pending: Set<Promise<void>>;
  joinStarted: boolean;
  settlement?: Promise<"settled" | "uncertain">;
  settlementWork?: Promise<"settled" | "uncertain">;
};
type VoiceTransport = (
  shardId: number,
  payload: GatewaySendPayload,
) => Promise<void>;
const transports = new WeakMap<Client, VoiceTransport>();
export function buildOwnedVoiceStrategy(
  client: Client,
  manager: ConstructorParameters<typeof SimpleShardingStrategy>[0],
): SimpleShardingStrategy {
  const strategy = new SimpleShardingStrategy(manager);
  transports.set(client, (shardId, payload) => strategy.send(shardId, payload));
  return strategy;
}
function record(
  reservation: SessionReservation,
  state: VoiceRecord["state"],
): VoiceRecord {
  return {
    pk: `VOICE#${reservation.guildId}`,
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: reservation.guildId,
    meetingId: reservation.meetingId,
    ownerInstanceId: reservation.ownerInstanceId,
    attemptId: reservation.voiceOperationAttemptId,
    executionVersion: reservation.executionVersion,
    sessionMode: reservation.sessionMode,
    state,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Serializes local attempts and seals the actual SDK adapter, including SDK reconnect callbacks. */
export function createGuildVoiceOperationService(
  repository: Pick<DeploymentControlRepository, "writeVoice" | "getRecord">,
  transportForClient = (client: Client) => transports.get(client),
) {
  const operations = new Map<string, Operation>();
  const settledReservations = new WeakSet<SessionReservation>();
  const settlementProofs = new WeakMap<SessionReservation, Promise<void>>();
  const unproved = new Promise<void>(() => {});
  function prepareOwnedVoiceSession(
    reservation: SessionReservation,
  ): Operation {
    if (operations.has(reservation.guildId))
      throw new Error("Voice operation already owned");
    let acknowledge = () => {};
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    settlementProofs.set(reservation, settled);
    const operation: Operation = {
      reservation,
      state: "joining",
      closed: false,
      attempted: false,
      ambiguous: false,
      acknowledged: false,
      leaveIssued: false,
      cleanup: () => {},
      acknowledge,
      acknowledgment,
      resolveSettled,
      writes: Promise.resolve(),
      pending: new Set(),
      joinStarted: false,
    };
    operations.set(reservation.guildId, operation);
    return operation;
  }
  function persist(operation: Operation, state: VoiceRecord["state"]) {
    const next = operation.writes.then(async () => {
      if (state === "settled" && operation.ambiguous)
        throw new Error("Voice settlement proof invalidated");
      const expected = record(operation.reservation, operation.state);
      const requested = record(operation.reservation, state);
      let result;
      try {
        result = await repository.writeVoice(requested, {
          attemptId: expected.attemptId,
          state: expected.state,
          ownerInstanceId: expected.ownerInstanceId,
          meetingId: expected.meetingId,
        });
      } catch {
        // Never replay an unknown write: only its exact strong readback is proof.
        const observed = await repository
          .getRecord(requested.pk, requested.sk)
          .catch(() => undefined);
        if (!isDeepStrictEqual(observed, requested)) {
          invalidate(operation, "persistence_uncertain");
          throw new Error("Voice persistence unproved");
        }
        result = "applied";
      }
      if (result !== "applied") {
        invalidate(operation, "ownership_changed");
        throw new Error("Voice operation ownership changed");
      }
      operation.state = state;
    });
    operation.writes = next.catch(() => {});
    return next;
  }
  function completeSettlement(operation: Operation): boolean {
    if (operation.ambiguous) return false;
    settledReservations.add(operation.reservation);
    operation.cleanup();
    operations.delete(operation.reservation.guildId);
    operation.resolveSettled();
    return true;
  }
  async function settleAfterLateAcknowledgment(operation: Operation) {
    await operation.acknowledgment;
    if (operation.ambiguous || operation.pending.size) return;
    try {
      await persist(operation, "settled");
      if (completeSettlement(operation))
        console.info("Owned voice settlement", {
          phase: "settled",
          reason: "late_acknowledgment",
        });
    } catch {
      operation.cleanup();
    }
  }
  async function joinOwnedVoiceSession(
    reservation: SessionReservation,
    options: OwnedVoiceJoinOptions,
  ): Promise<VoiceConnection> {
    const operation =
      operations.get(reservation.guildId) ??
      prepareOwnedVoiceSession(reservation);
    if (
      options.signal.aborted ||
      operation.closed ||
      operation.joinStarted ||
      operation.reservation !== reservation
    )
      throw new Error("Voice operation is closed or already owned");
    operation.joinStarted = true;
    const client = options.guild.client;
    const invalidateShard = (shardId: number) => {
      if (shardId === options.guild.shardId)
        invalidate(operation, "shard_discontinuity");
    };
    const disconnect = (_event: unknown, shardId: number) =>
      invalidateShard(shardId);
    const onPacket = (packet: unknown, shardId: number) => {
      if (shardId !== options.guild.shardId) return;
      const parsed = voiceDispatch.safeParse(packet);
      if (!parsed.success) return;
      const { d, s } = parsed.data;
      if (d.guild_id !== reservation.guildId || d.user_id !== client.user?.id)
        return;
      if (!operation.attempted) return;
      if (operation.sequence !== undefined && s <= operation.sequence) {
        invalidate(operation, "stale_sequence");
        return;
      }
      operation.sequence = s;
      if (
        d.channel_id === options.voiceChannel.id &&
        (!operation.closed || operation.session === d.session_id)
      ) {
        observeJoin(operation, d.session_id);
      } else observeLeave(operation, parsed.data);
    };
    client.on("raw", onPacket);
    client.on("shardDisconnect", disconnect);
    client.on("shardReconnecting", invalidateShard);
    client.on("shardResume", invalidateShard);
    client.on("shardReady", invalidateShard);
    const abort = () => {
      void settleOwnedVoiceSession(reservation);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    operation.cleanup = () => {
      client.off("raw", onPacket);
      client.off("shardDisconnect", disconnect);
      client.off("shardReconnecting", invalidateShard);
      client.off("shardResume", invalidateShard);
      client.off("shardReady", invalidateShard);
      options.signal.removeEventListener("abort", abort);
    };
    // discord.js deliberately marks its adapter type internal; the public SDK owns this boundary.
    const guildAdapter: DiscordGatewayAdapterCreator = options.guild
      .voiceAdapterCreator as DiscordGatewayAdapterCreator;
    const transport = transportForClient(client);
    if (!transport) {
      operation.cleanup();
      throw new Error("Tracked voice transport is not installed");
    }
    let leavePermitted = false;
    const adapterCreator: DiscordGatewayAdapterCreator = (methods) => {
      const adapter = guildAdapter({
        onVoiceStateUpdate: (data) => {
          if (!operation.closed) methods.onVoiceStateUpdate(data);
        },
        onVoiceServerUpdate: (data) => {
          if (!operation.closed) methods.onVoiceServerUpdate(data);
        },
        destroy: () => {
          invalidate(operation, "adapter_destroyed");
          if (!operation.closed) methods.destroy();
        },
      });
      return {
        sendPayload(payload) {
          if (
            operation.closed &&
            !(leavePermitted && payload.d.channel_id === null)
          )
            return false;
          if (operation.closed) {
            leavePermitted = false;
            operation.leaveIssued = true;
            operation.closeSequence = operation.sequence;
          }
          return submit(operation, () =>
            transport(options.guild.shardId, payload),
          );
        },
        destroy: () => adapter.destroy(),
      };
    };
    try {
      operation.connection = joinVoiceChannel({
        channelId: options.voiceChannel.id,
        guildId: reservation.guildId,
        adapterCreator,
        selfDeaf: !options.captureAudio,
        selfMute: false,
      });
      // This is the sole permitted leave after sealing, consumed synchronously by destroy().
      const connection = operation.connection;
      connection.on("daveResetSummary", (summary) => {
        console.info("DAVE reset readiness summary:", JSON.stringify(summary));
      });
      const close = () => {
        leavePermitted = true;
        if (connection.state.status !== VoiceConnectionStatus.Destroyed)
          connection.destroy();
        leavePermitted = false;
      };
      closeOperations.set(operation, close);
      if (options.signal.aborted || operation.closed) {
        await settleOwnedVoiceSession(reservation);
        throw new Error("Voice operation closed during join");
      }
      if (operation.closed)
        throw new Error("Voice operation closed during initialization");
      return connection;
    } catch (error) {
      await settleOwnedVoiceSession(reservation);
      throw error;
    }
  }
  const closeOperations = new WeakMap<Operation, () => void>();
  async function closeOwnedVoiceTransport(
    operation: Operation,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const sendsFinished = await drainTransportBeforeDeadline(
      operation,
      deadline,
      signal,
    );
    if (!sendsFinished || operation.ambiguous) {
      destroyWithoutLeave(operation);
      return;
    }
    // No delayed continuation may issue this leave after the deadline.
    if (Date.now() < deadline && !signal?.aborted)
      closeOperations.get(operation)?.();
    else {
      invalidate(operation, signal?.aborted ? "cancelled" : "leave_deadline");
      destroyWithoutLeave(operation);
    }
    await drainTransportBeforeDeadline(operation, deadline, signal);
    await waitForAcknowledgment(operation, deadline, signal);
  }
  async function settleVoiceOperation(
    operation: Operation,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"settled" | "uncertain"> {
    await closeOwnedVoiceTransport(operation, deadline, signal);
    const closed =
      !operation.connection ||
      operation.connection.state.status === VoiceConnectionStatus.Destroyed;
    const outcome =
      closed &&
      !operation.ambiguous &&
      (!operation.attempted || operation.acknowledged)
        ? "settled"
        : "uncertain";
    try {
      await persist(operation, outcome);
    } catch {
      operation.cleanup();
      return "uncertain";
    }
    if (outcome === "settled")
      return completeSettlement(operation) ? "settled" : "uncertain";
    if (!operation.ambiguous && operation.leaveIssued)
      void settleAfterLateAcknowledgment(operation);
    else operation.cleanup();
    return "uncertain";
  }
  async function settleOwnedVoiceSession(
    reservation: SessionReservation,
    options: VoiceSettlementOptions = {},
  ): Promise<"settled" | "uncertain"> {
    if (settledReservations.has(reservation)) return "settled";
    const operation = operations.get(reservation.guildId);
    if (!operation || operation.reservation !== reservation) {
      console.info("Owned voice settlement", {
        phase: "refused",
        reason: operation ? "foreign_operation" : "missing_operation",
      });
      return "uncertain";
    }
    const deadline = options.deadline ?? Date.now() + SETTLEMENT_TIMEOUT_MS;
    if (operation.settlement) return operation.settlement;
    operation.closed = true;
    const work = settleVoiceOperation(operation, deadline, options.signal);
    operation.settlementWork = work;
    operation.settlement = beforeDeadline(work, deadline, options.signal).then(
      (finished) => (finished ? work : "uncertain"),
    );
    return operation.settlement;
  }
  async function waitOwnedVoiceEffects(
    reservation: SessionReservation,
  ): Promise<void> {
    const operation = operations.get(reservation.guildId);
    if (!operation || operation.reservation !== reservation) return;
    if (!operation.closed)
      throw new Error("Voice operation must be sealed before draining effects");
    await operation.settlementWork;
    while (operation.pending.size)
      await Promise.allSettled([...operation.pending]);
    await Promise.allSettled([operation.writes]);
  }
  function whenOwnedVoiceSettled(
    reservation: SessionReservation,
  ): Promise<void> {
    return settlementProofs.get(reservation) ?? unproved;
  }
  return {
    whenOwnedVoiceSettled,
    prepareOwnedVoiceSession,
    joinOwnedVoiceSession,
    settleOwnedVoiceSession,
    waitOwnedVoiceEffects,
  };
}
function destroyWithoutLeave(operation: Operation): void {
  if (operation.connection?.state.status !== VoiceConnectionStatus.Destroyed)
    operation.connection?.destroy(false);
}
async function drainTransportBeforeDeadline(
  operation: Operation,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const finished = await beforeDeadline(
    Promise.all([...operation.pending]),
    deadline,
    signal,
  );
  if (!finished)
    invalidate(operation, signal?.aborted ? "cancelled" : "transport_timeout");
  return finished;
}
async function waitForAcknowledgment(
  operation: Operation,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  if (
    operation.attempted &&
    !operation.ambiguous &&
    !(await beforeDeadline(operation.acknowledgment, deadline, signal))
  ) {
    // Cancelling an ACK-only wait cannot reopen the already drained, sealed transport.
    console.info("Owned voice settlement", {
      phase: "waiting",
      reason: signal?.aborted
        ? "acknowledgment_wait_cancelled"
        : "acknowledgment_timeout",
    });
  }
}
function invalidate(operation: Operation, reason: string): void {
  if (!operation.ambiguous)
    console.info("Owned voice settlement", {
      phase: operation.closed ? "sealed" : "joining",
      reason,
    });
  operation.ambiguous = true;
  if (operation.closed) operation.cleanup();
}
function observeJoin(operation: Operation, sessionId: string): void {
  if (operation.session && operation.session !== sessionId)
    invalidate(operation, "session_changed");
  operation.session = sessionId;
}
function observeLeave(
  operation: Operation,
  packet: z.infer<typeof voiceDispatch>,
): void {
  if (operation.ambiguous) return;
  if (!operation.closed || !operation.leaveIssued)
    invalidate(operation, "leave_not_issued");
  else if (!operation.session) invalidate(operation, "session_unknown");
  else if (operation.session !== packet.d.session_id)
    invalidate(operation, "session_changed");
  else if (packet.d.channel_id !== null)
    invalidate(operation, "channel_changed");
  else if (
    operation.closeSequence === undefined ||
    packet.s <= operation.closeSequence
  )
    invalidate(operation, "stale_sequence");
  else {
    operation.acknowledged = true;
    operation.acknowledge();
  }
}
function submit(operation: Operation, send: () => Promise<void>): boolean {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  operation.pending.add(pending);
  operation.attempted = true;
  try {
    void send()
      .catch(() => {
        invalidate(operation, "transport_rejected");
      })
      .finally(() => {
        operation.pending.delete(pending);
        finish();
      });
    return true;
  } catch {
    invalidate(operation, "transport_rejected");
    operation.pending.delete(pending);
    finish();
    return false;
  }
}
async function beforeDeadline(
  promise: Promise<unknown>,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (Date.now() >= deadline || signal?.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        abort = () => resolve(false);
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, deadline - Date.now());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
const service = createGuildVoiceOperationService({
  getRecord: (pk, sk) => getDeploymentControlRepository().getRecord(pk, sk),
  writeVoice: (record, expected) =>
    getDeploymentControlRepository().writeVoice(record, expected),
});
export const joinOwnedVoiceSession = service.joinOwnedVoiceSession;
export const settleOwnedVoiceSession = service.settleOwnedVoiceSession;
export const prepareOwnedVoiceSession = service.prepareOwnedVoiceSession;

export const waitOwnedVoiceEffects = service.waitOwnedVoiceEffects;

export const whenOwnedVoiceSettled = service.whenOwnedVoiceSettled;
