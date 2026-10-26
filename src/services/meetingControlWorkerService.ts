import { resolveFixtureStartScope } from "./productionFixtureCommandService";
import type { NewWorkScope } from "../types/productionIntroduction";
import {
  InitiatingStopInterruption,
  sameOriginalSession,
} from "./meetingStopInterruption";
import type { Client } from "discord.js";
import { randomUUID } from "node:crypto";
import type { MeetingControlCommand } from "../types/meetingControl";
import type { WorkAdmissionAuthority } from "../types/deploymentControl";
import {
  beginRuntimeWorkClaim,
  type RuntimeWorkClaim,
} from "./runtimeWorkAdmissionService";
import { getOwnedSessionReservations } from "./activeMeetingLeaseService";
import { getMeetingControlCommandRepository } from "../repositories/meetingControlCommandRepository";
import { executeMeetingControlCommand } from "./meetingControlBotService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

const WORKER_POLL_INTERVAL_MS = 2_000;
const WORKER_CLAIM_SECONDS = 60;
const WORKER_CLAIM_RENEWAL_MS = 30_000;
const WORKER_BATCH_SIZE = 5;

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pendingPoll: Promise<void> | undefined;
let workerStopped = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

export function processMeetingControlCommand(
  client: Client,
  command: MeetingControlCommand,
): Promise<void> {
  let work: RuntimeWorkClaim;
  const instanceId = getRuntimeInstanceId();
  const local =
    command.commandType !== "start_meeting" && command.input.serverId
      ? getOwnedSessionReservations().find(
          ({ reservation }) => reservation.guildId === command.input.serverId,
        )
      : undefined;
  try {
    work = beginRuntimeWorkClaim(
      "control",
      command.requestId,
      local
        ? {
            guildId: local.reservation.guildId,
            meetingId: local.reservation.meetingId,
          }
        : undefined,
    );
  } catch {
    return Promise.resolve();
  }
  return work.trackPromise(() => runCommand(client, command, instanceId, work));
}

function isOriginalStopInterruption(
  error: unknown,
  command: MeetingControlCommand,
  authority: WorkAdmissionAuthority,
  instanceId: string,
): error is InitiatingStopInterruption {
  return (
    error instanceof InitiatingStopInterruption &&
    command.commandType === "stop_meeting" &&
    authority.kind === "session" &&
    sameOriginalSession(authority.ownership, error.original) &&
    error.original.ownerInstanceId === instanceId &&
    !error.signal.aborted &&
    Date.now() < error.deadline
  );
}

async function resolveQueuedScope(
  command: MeetingControlCommand,
  authority: WorkAdmissionAuthority,
  repository: ReturnType<typeof getMeetingControlCommandRepository>,
) {
  if (command.commandType !== "start_meeting" || authority.kind !== "serving")
    return undefined;
  const stored = await repository.getCommand(command.requestId);
  if (!stored) throw new Error("Queued command missing");
  return resolveFixtureStartScope(stored, authority.context.maintenance);
}

async function runCommand(
  client: Client,
  command: MeetingControlCommand,
  instanceId: string,
  work: RuntimeWorkClaim,
) {
  const repository = getMeetingControlCommandRepository();
  let authority: WorkAdmissionAuthority;
  let scope: NewWorkScope | undefined;
  try {
    authority = await work.authority();
    scope = await resolveQueuedScope(command, authority, repository);
  } catch {
    await work.settle();
    return;
  }
  const claimId = randomUUID();
  const claimInput = {
    requestId: command.requestId,
    instanceId,
    claimId,
    nowEpochSeconds: epochSeconds(),
    claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
    updatedAt: nowIso(),
    authority,
    scope,
  };
  work.recordClaim({
    claimId,
    instanceId,
    expiresAt: claimInput.claimExpiresAt,
  });
  let claimed;
  try {
    claimed = await repository.claimCommand(claimInput);
  } catch {
    work.fence();
    await work.settle();
    return;
  }
  if (!claimed) {
    await work.settle();
    return;
  }
  try {
    work.claimed();
  } catch {
    work.fence();
    await work.settle();
    return;
  }
  const assertOwned = async () => {
    work.signal.throwIfAborted();
    if (
      !(await repository.renewCommand({
        ...claimInput,
        nowEpochSeconds: epochSeconds(),
        claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
        updatedAt: nowIso(),
      }))
    ) {
      work.fence();
      throw new Error("Control claim lost");
    }
    work.signal.throwIfAborted();
  };
  const renewalTimer = setInterval(() => {
    void work
      .trackEffect(() => assertOwned().catch(() => work.fence()))
      .catch(() => {});
  }, WORKER_CLAIM_RENEWAL_MS);
  renewalTimer.unref();
  try {
    const result = await executeMeetingControlCommand(
      client,
      claimed,
      assertOwned,
      work.signal,
      scope,
    );
    work.signal.throwIfAborted();
    const committed = await repository.completeCommand({
      requestId: command.requestId,
      instanceId,
      claimId,
      nowEpochSeconds: epochSeconds(),
      updatedAt: nowIso(),
      result,
    });
    if (!committed) work.fence();
    else work.acknowledgeTerminal();
  } catch (error) {
    if (
      work.signal.aborted &&
      isOriginalStopInterruption(error, command, authority, instanceId)
    ) {
      try {
        const committed = await work.trackTerminalEffect(
          () =>
            repository.failCommand(
              {
                requestId: command.requestId,
                instanceId,
                claimId,
                nowEpochSeconds: epochSeconds(),
                updatedAt: nowIso(),
                error: error.message,
              },
              error.signal,
            ),
          { claimId, instanceId, expiresAt: claimInput.claimExpiresAt },
          error.signal,
        );
        if (committed) work.acknowledgeTerminal();
      } catch {
        work.fence();
      }
    } else if (!work.signal.aborted) {
      try {
        if (
          !(await repository.failCommand({
            requestId: command.requestId,
            instanceId,
            claimId,
            nowEpochSeconds: epochSeconds(),
            updatedAt: nowIso(),
            error: error instanceof Error ? error.message : String(error),
          }))
        )
          work.fence();
        else work.acknowledgeTerminal();
      } catch {
        work.fence();
      }
    }
  } finally {
    clearInterval(renewalTimer);
    await work.settle();
  }
}

function pollMeetingControlCommands(client: Client): Promise<void> {
  if (workerStopped) return Promise.resolve();
  if (pendingPoll) return pendingPoll;
  let complete!: () => void;
  const owned = new Promise<void>((resolve) => {
    complete = resolve;
  });
  pendingPoll = owned;
  void runPoll(client).finally(() => {
    pendingPoll = undefined;
    complete();
  });
  return owned;
}
async function runPoll(client: Client) {
  try {
    const commands =
      await getMeetingControlCommandRepository().listClaimablePendingCommands({
        instanceId: getRuntimeInstanceId(),
        nowEpochSeconds: epochSeconds(),
        limit: WORKER_BATCH_SIZE,
      });
    for (const command of commands) {
      if (workerStopped) break;
      await processMeetingControlCommand(client, command);
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
