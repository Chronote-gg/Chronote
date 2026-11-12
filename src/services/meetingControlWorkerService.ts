import type { Client } from "discord.js";
import { randomUUID } from "node:crypto";
import {
  MEETING_CONTROL_COMMAND_TYPES,
  type LiveMeetingCommandInput,
  type MeetingControlCommand,
  type MeetingControlCommandResult,
} from "../types/meetingControl";
import { getMeetingControlCommandRepository } from "../repositories/meetingControlCommandRepository";
import { executeMeetingControlCommand } from "./meetingControlBotService";
import { LIFECYCLE } from "./lifecycleTiming";
import { getActiveMeetingLeaseForGuild, isLeaseActive } from "./meetingLease";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { operationSignal } from "./shutdownSignal";
import { isEligible, isWorkerFresh } from "./workerRegistry";
import { getAllMeetings } from "../meetings";

const WORKER_POLL_INTERVAL_MS = 2_000;
const WORKER_CLAIM_SECONDS = 60;
const WORKER_CLAIM_RENEWAL_MS = 30_000;
const WORKER_BATCH_SIZE = 5;

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pendingPoll: Promise<void> | undefined;
let workerStopped = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type ExecuteCommand = typeof executeMeetingControlCommand;

export async function processMeetingControlCommand(
  client: Client,
  command: MeetingControlCommand,
  onBehalfOf?: { takeOverFrom: string; execute: ExecuteCommand },
): Promise<void> {
  const repository = getMeetingControlCommandRepository();
  const instanceId = getRuntimeInstanceId();
  const execute = onBehalfOf?.execute ?? executeMeetingControlCommand;
  const claimInput = {
    requestId: command.requestId,
    instanceId,
    claimId: randomUUID(),
    nowEpochSeconds: epochSeconds(),
    claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
    updatedAt: nowIso(),
    takeOverFrom: onBehalfOf?.takeOverFrom,
  };
  // A claim that fails to write leaves the command for its claim to expire and another poll to take.
  const claimed = await repository.claimCommand(claimInput).catch((error) => {
    console.warn("Meeting control command claim failed", error);
    return undefined;
  });
  if (!claimed) return;
  const job = new AbortController();
  const signal = operationSignal(job.signal);
  const assertOwned = async () => {
    signal.throwIfAborted();
    if (
      !(await repository.renewCommand({
        ...claimInput,
        nowEpochSeconds: epochSeconds(),
        claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
        updatedAt: nowIso(),
      }))
    ) {
      job.abort();
      throw new Error("Control claim lost");
    }
    signal.throwIfAborted();
  };
  const renewalTimer = setInterval(() => {
    void assertOwned().catch(() => job.abort());
  }, WORKER_CLAIM_RENEWAL_MS);
  renewalTimer.unref();
  const terminal = {
    requestId: command.requestId,
    instanceId,
    claimId: claimInput.claimId,
  };
  try {
    const result = await execute(client, claimed, assertOwned, signal);
    await repository.completeCommand({
      ...terminal,
      nowEpochSeconds: epochSeconds(),
      updatedAt: nowIso(),
      result,
    });
  } catch (error) {
    // Always attempted, so an executed command never returns to the queue; a lost claim fails the write's own condition.
    await repository
      .failCommand({
        ...terminal,
        nowEpochSeconds: epochSeconds(),
        updatedAt: nowIso(),
        error: errorMessage(error),
      })
      .catch((failure) =>
        console.warn("Meeting control command failure write failed", failure),
      );
  } finally {
    clearInterval(renewalTimer);
  }
}

/** What a gone worker's recording would have answered, now that no live lease names it. */
const answerForEndedMeeting: ExecuteCommand = async (_client, command) => {
  const input: LiveMeetingCommandInput = command.input;
  if (
    command.commandType === MEETING_CONTROL_COMMAND_TYPES.STOP_MEETING &&
    input.serverId &&
    input.meetingId
  ) {
    const ended: MeetingControlCommandResult = {
      status: "ended",
      serverId: input.serverId,
      meetingId: input.meetingId,
    };
    return ended;
  }
  // The same refusal the owner gives once its meeting is gone.
  throw new Error("Meeting not found.");
};

/**
 * A command addressed to a worker that has left the registry would otherwise
 * wait out its expiry. The lease says whether the meeting is still live: if
 * it is, the command is left for its holder; if not, the recording ended.
 */
async function answerForGoneOwner(
  client: Client,
  command: MeetingControlCommand,
  takeOverFrom: string,
): Promise<void> {
  if (command.commandType === MEETING_CONTROL_COMMAND_TYPES.START_MEETING)
    return;
  const input: LiveMeetingCommandInput = command.input;
  if (!input.serverId) return;
  let lease;
  try {
    lease = await getActiveMeetingLeaseForGuild(
      input.serverId,
      AbortSignal.timeout(LIFECYCLE.leaseHeartbeatMs),
    );
  } catch (error) {
    console.warn("Control command owner lease read failed", {
      requestId: command.requestId,
      error,
    });
    return;
  }
  if (
    lease &&
    isLeaseActive(lease) &&
    (!input.meetingId || lease.meetingId === input.meetingId)
  )
    return;
  await processMeetingControlCommand(client, command, {
    takeOverFrom,
    execute: answerForEndedMeeting,
  });
}

/** A draining worker keeps only the commands addressed to the meetings it is still recording. */
function pollScope(): "all" | "own" | undefined {
  if (isEligible()) return "all";
  return getAllMeetings().length > 0 ? "own" : undefined;
}

async function handlePolledCommand(
  client: Client,
  command: MeetingControlCommand,
  scope: "all" | "own",
  instanceId: string,
): Promise<void> {
  const target = command.targetOwnerInstanceId;
  if (target === instanceId || (!target && scope === "all"))
    return processMeetingControlCommand(client, command);
  if (target && scope === "all" && !isWorkerFresh(target))
    return answerForGoneOwner(client, command, target);
}

export function pollMeetingControlCommands(client: Client): Promise<void> {
  if (workerStopped) return Promise.resolve();
  const scope = pollScope();
  if (!scope) return Promise.resolve();
  if (pendingPoll) return pendingPoll;
  let complete!: () => void;
  const owned = new Promise<void>((resolve) => {
    complete = resolve;
  });
  pendingPoll = owned;
  void runPoll(client, scope).finally(() => {
    pendingPoll = undefined;
    complete();
  });
  return owned;
}
async function runPoll(client: Client, scope: "all" | "own") {
  try {
    const instanceId = getRuntimeInstanceId();
    const commands =
      await getMeetingControlCommandRepository().listClaimablePendingCommands({
        instanceId,
        nowEpochSeconds: epochSeconds(),
        limit: WORKER_BATCH_SIZE,
      });
    // ponytail: targets are filtered after the query, so a full batch of commands for other workers can delay this worker's until they drain; a target index is the upgrade.
    for (const command of commands) {
      if (workerStopped) break;
      await handlePolledCommand(client, command, scope, instanceId);
    }
  } catch (error) {
    console.error("Meeting control command worker failed", error);
  }
}

export function startMeetingControlCommandWorker(client: Client) {
  if (workerTimer || workerStopped) return;
  void pollMeetingControlCommands(client);
  workerTimer = setInterval(() => {
    void pollMeetingControlCommands(client);
  }, WORKER_POLL_INTERVAL_MS);
}

export function stopMeetingControlCommandWorker(): Promise<void> {
  workerStopped = true;
  clearInterval(workerTimer);
  workerTimer = undefined;
  return pendingPoll ?? Promise.resolve();
}
