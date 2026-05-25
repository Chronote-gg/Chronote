import type { Client } from "discord.js";
import { getMeetingControlCommandRepository } from "../repositories/meetingControlCommandRepository";
import { executeMeetingControlCommand } from "./meetingControlBotService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

const WORKER_POLL_INTERVAL_MS = 2_000;
const WORKER_CLAIM_SECONDS = 60;
const WORKER_CLAIM_RENEWAL_MS = 30_000;
const WORKER_BATCH_SIZE = 5;

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pollInProgress = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

const renewClaim = async (requestId: string, instanceId: string) =>
  getMeetingControlCommandRepository().claimCommand({
    requestId,
    instanceId,
    nowEpochSeconds: epochSeconds(),
    claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
    updatedAt: nowIso(),
  });

const startClaimRenewal = (requestId: string, instanceId: string) =>
  setInterval(() => {
    void renewClaim(requestId, instanceId).catch((error) => {
      console.error("Meeting control command claim renewal failed", error);
    });
  }, WORKER_CLAIM_RENEWAL_MS);

async function pollMeetingControlCommands(client: Client) {
  if (pollInProgress) return;
  pollInProgress = true;
  const repository = getMeetingControlCommandRepository();
  const instanceId = getRuntimeInstanceId();
  const now = epochSeconds();
  try {
    const commands = await repository.listClaimablePendingCommands({
      instanceId,
      nowEpochSeconds: now,
      limit: WORKER_BATCH_SIZE,
    });
    for (const command of commands) {
      const claimed = await repository.claimCommand({
        requestId: command.requestId,
        instanceId,
        nowEpochSeconds: epochSeconds(),
        claimExpiresAt: epochSeconds() + WORKER_CLAIM_SECONDS,
        updatedAt: nowIso(),
      });
      if (!claimed) continue;
      const renewalTimer = startClaimRenewal(claimed.requestId, instanceId);
      try {
        const result = await executeMeetingControlCommand(client, claimed);
        await repository.completeCommand({
          requestId: claimed.requestId,
          instanceId,
          updatedAt: nowIso(),
          result,
        });
      } catch (error) {
        await repository.failCommand({
          requestId: claimed.requestId,
          instanceId,
          updatedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearInterval(renewalTimer);
      }
    }
  } catch (error) {
    console.error("Meeting control command worker failed", error);
  } finally {
    pollInProgress = false;
  }
}

export function startMeetingControlCommandWorker(client: Client) {
  if (workerTimer) return;
  void pollMeetingControlCommands(client);
  workerTimer = setInterval(() => {
    void pollMeetingControlCommands(client);
  }, WORKER_POLL_INTERVAL_MS);
}

export function stopMeetingControlCommandWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = undefined;
}
