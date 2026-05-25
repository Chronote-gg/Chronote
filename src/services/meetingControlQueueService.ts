import crypto from "node:crypto";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
} from "./activeMeetingLeaseService";
import { getMeetingControlCommandRepository } from "../repositories/meetingControlCommandRepository";
import type {
  MeetingControlCommand,
  MeetingControlCommandInput,
  MeetingControlCommandResult,
  MeetingControlCommandType,
} from "../types/meetingControl";

const COMMAND_TTL_SECONDS = 15 * 60;
const DEFAULT_WAIT_TIMEOUT_MS = 25_000;
const WAIT_POLL_INTERVAL_MS = 500;

export type QueueMeetingControlCommandInput = {
  commandType: MeetingControlCommandType;
  userId: string;
  input: MeetingControlCommandInput;
  targetOwnerInstanceId?: string;
  waitTimeoutMs?: number;
};

export type MeetingControlCommandSnapshot = {
  requestId: string;
  queueStatus: MeetingControlCommand["queueStatus"];
  commandType: MeetingControlCommandType;
  createdAt: string;
  updatedAt: string;
  result?: MeetingControlCommandResult;
  error?: string;
};

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

const sleep = (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const toSnapshot = (
  command: MeetingControlCommand,
): MeetingControlCommandSnapshot => ({
  requestId: command.requestId,
  queueStatus: command.queueStatus,
  commandType: command.commandType,
  createdAt: command.createdAt,
  updatedAt: command.updatedAt,
  result: command.result,
  error: command.error,
});

export async function resolveTargetOwnerForGuild(guildId?: string) {
  if (!guildId) return undefined;
  const lease = await getActiveMeetingLeaseForGuild(guildId);
  return lease && isLeaseActive(lease) ? lease.ownerInstanceId : undefined;
}

export async function enqueueMeetingControlCommand(
  input: QueueMeetingControlCommandInput,
): Promise<MeetingControlCommand> {
  const createdAt = nowIso();
  const command: MeetingControlCommand = {
    requestId: crypto.randomUUID(),
    queueStatus: "pending",
    commandType: input.commandType,
    userId: input.userId,
    input: input.input,
    targetOwnerInstanceId: input.targetOwnerInstanceId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: epochSeconds() + COMMAND_TTL_SECONDS,
  };
  await getMeetingControlCommandRepository().writeCommand(command);
  return command;
}

export async function waitForMeetingControlCommand(
  requestId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<MeetingControlCommandSnapshot | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const command =
      await getMeetingControlCommandRepository().getCommand(requestId);
    if (!command) return undefined;
    if (command.queueStatus !== "pending") return toSnapshot(command);
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
  const command =
    await getMeetingControlCommandRepository().getCommand(requestId);
  return command ? toSnapshot(command) : undefined;
}

export async function queueMeetingControlCommand(
  input: QueueMeetingControlCommandInput,
): Promise<MeetingControlCommandSnapshot> {
  const command = await enqueueMeetingControlCommand(input);
  const waited = await waitForMeetingControlCommand(
    command.requestId,
    input.waitTimeoutMs,
  );
  return waited ?? toSnapshot(command);
}

export async function getMeetingControlCommandForUser(
  requestId: string,
  userId: string,
): Promise<MeetingControlCommandSnapshot | undefined> {
  const command =
    await getMeetingControlCommandRepository().getCommand(requestId);
  if (!command || command.userId !== userId) return undefined;
  return toSnapshot(command);
}
