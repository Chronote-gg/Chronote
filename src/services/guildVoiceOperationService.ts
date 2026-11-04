import { isDeepStrictEqual } from "node:util";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { z } from "zod";
import {
  DiscordAPIError,
  GatewayOpcodes,
  RESTJSONErrorCodes,
  SimpleShardingStrategy,
  type Client,
  type GatewaySendPayload,
  type Guild,
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
/** Part of the settlement window held back for the REST check when no gateway confirmation arrives. */
const REST_PROOF_RESERVE_MS = 1_500;
const REST_UNAVAILABLE = Symbol("rest_unavailable");
const voiceDispatch = z.object({
  t: z.literal("VOICE_STATE_UPDATE"),
  d: z.object({
    guild_id: z.string(),
    user_id: z.string(),
    channel_id: z.string().nullable(),
  }),
});
type LeaveProof = "gateway_leave" | "rest_not_in_voice";
type Operation = {
  reservation: SessionReservation;
  state: VoiceRecord["state"];
  closed: boolean;
  attempted: boolean;
  ambiguous: boolean;
  acknowledged: boolean;
  proof?: LeaveProof;
  leaveIssued: boolean;
  connection?: VoiceConnection;
  guild?: Guild;
  leave?(): void;
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
          reason: `late_${operation.proof}`,
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
    operation.guild = options.guild;
    const client = options.guild.client;
    // The leave is the only payload after sealing, so any later report of the bot outside voice proves it.
    const onPacket = (packet: unknown, shardId: number) => {
      if (shardId !== options.guild.shardId || !operation.leaveIssued) return;
      const parsed = voiceDispatch.safeParse(packet);
      if (!parsed.success) return;
      const { d } = parsed.data;
      if (
        d.guild_id === reservation.guildId &&
        d.user_id === client.user?.id &&
        d.channel_id === null
      )
        acknowledge(operation, "gateway_leave");
    };
    client.on("raw", onPacket);
    const abort = () => {
      void settleOwnedVoiceSession(reservation);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    operation.cleanup = () => {
      client.off("raw", onPacket);
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
    operation.leave = () => {
      operation.leaveIssued = true;
      submit(operation, () =>
        transport(options.guild.shardId, {
          op: GatewayOpcodes.VoiceStateUpdate,
          d: {
            guild_id: reservation.guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false,
          },
        }),
      );
      destroyWithoutLeave(operation);
    };
    const adapterCreator: DiscordGatewayAdapterCreator = (methods) => {
      const adapter = guildAdapter({
        onVoiceStateUpdate: (data) => {
          if (!operation.closed) methods.onVoiceStateUpdate(data);
        },
        onVoiceServerUpdate: (data) => {
          if (!operation.closed) methods.onVoiceServerUpdate(data);
        },
        destroy: () => {
          if (!operation.closed) methods.destroy();
        },
      });
      return {
        sendPayload(payload) {
          if (operation.closed) return false;
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
      const connection = operation.connection;
      connection.on("daveResetSummary", (summary) => {
        console.info("DAVE reset readiness summary:", JSON.stringify(summary));
      });
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
    if (!sendsFinished) {
      destroyWithoutLeave(operation);
      return;
    }
    // No delayed continuation may issue this leave after the deadline.
    if (Date.now() >= deadline || signal?.aborted) {
      invalidate(operation, signal?.aborted ? "cancelled" : "leave_deadline");
      destroyWithoutLeave(operation);
      return;
    }
    if (operation.attempted) operation.leave?.();
    else destroyWithoutLeave(operation);
    if (await drainTransportBeforeDeadline(operation, deadline, signal))
      await waitForLeaveProof(operation, deadline, signal);
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
    if (outcome === "settled") {
      if (!completeSettlement(operation)) return "uncertain";
      console.info("Owned voice settlement", {
        phase: "settled",
        reason: operation.proof ?? "no_voice_attempt",
      });
      return "settled";
    }
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
/** Waits for Discord to report the bot outside voice: the gateway first, then one fresh REST read. */
async function waitForLeaveProof(
  operation: Operation,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  const { guild } = operation;
  if (!operation.leaveIssued || operation.ambiguous || !guild) return;
  const gatewayDeadline = deadline - REST_PROOF_RESERVE_MS;
  if (await beforeDeadline(operation.acknowledgment, gatewayDeadline, signal))
    return;
  // Cancelling a proof-only wait cannot reopen the already drained, sealed transport.
  if (signal?.aborted) return logWaiting("acknowledgment_wait_cancelled");
  const restCheck = readVoiceChannelByRest(guild).then((channel) => {
    if (channel === null) acknowledge(operation, "rest_not_in_voice");
    return channel;
  });
  if (!(await beforeDeadline(restCheck, deadline, signal)))
    return logWaiting("rest_check_timeout");
  const channel = await restCheck;
  if (channel === REST_UNAVAILABLE) logWaiting("rest_unavailable");
  else if (channel !== null) logWaiting("rest_in_voice");
}
/** A fresh read of the bot's voice channel in this guild; null means Discord reports it outside voice. */
async function readVoiceChannelByRest(
  guild: Guild,
): Promise<string | null | typeof REST_UNAVAILABLE> {
  try {
    const state = await guild.voiceStates.fetch("@me", {
      force: true,
      cache: false,
    });
    return state.channelId;
  } catch (error) {
    return error instanceof DiscordAPIError &&
      error.code === RESTJSONErrorCodes.UnknownVoiceState
      ? null
      : REST_UNAVAILABLE;
  }
}
function logWaiting(reason: string): void {
  console.info("Owned voice settlement", { phase: "waiting", reason });
}
function acknowledge(operation: Operation, proof: LeaveProof): void {
  if (operation.acknowledged) return;
  operation.acknowledged = true;
  operation.proof = proof;
  operation.acknowledge();
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
