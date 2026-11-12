import type {
  FinisherRow,
  MeetingFinishRepository,
} from "../../src/repositories/meetingFinishRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type {
  HistoryKey,
  SessionReservation,
} from "../../src/types/meetingHistoryTransition";

export interface MeetingFinishHarness {
  repository: MeetingFinishRepository;
  seedHistory(row: MeetingHistory): Promise<void>;
  seedLease(lease: ActiveMeetingLease): Promise<void>;
  readHistory(key: HistoryKey): Promise<MeetingHistory | undefined>;
  dispose?(): Promise<void>;
}

export const NOW = 2_000_000_000;
export const GUILD = "synthetic-guild";
export const WORKER_A = "synthetic-worker-a";
export const WORKER_B = "synthetic-worker-b";
export const CLAIM = LIFECYCLE.finishClaimSeconds;
export const RENEW_SECONDS = LIFECYCLE.finishClaimRenewMs / 1000;
export const FIFTEEN_SECONDS = 15;

export function historyRow(
  id: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory {
  return {
    guildId: GUILD,
    channelId_timestamp: `synthetic-channel#2026-01-01T00:00:00.000Z#${id}`,
    meetingId: `synthetic-meeting-${id}`,
    channelId: "synthetic-channel",
    timestamp: "2026-01-01T00:00:00.000Z",
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    lifecycleVersion: 2,
    status: "in_progress",
    ownerInstanceId: WORKER_A,
    executionVersion: 1,
    ...overrides,
  };
}

export function keyOf(row: MeetingHistory): HistoryKey {
  return { guildId: row.guildId, channelId_timestamp: row.channelId_timestamp };
}

export function finisherRow(row: MeetingHistory): FinisherRow {
  return {
    guildId: row.guildId,
    channelId_timestamp: row.channelId_timestamp,
    meetingId: row.meetingId,
    status: row.status,
    timestamp: row.timestamp,
    updatedAt: row.updatedAt,
    lifecycleVersion: row.lifecycleVersion,
    finish: row.finish,
    ownerInstanceId: row.ownerInstanceId,
  };
}

export function reservationFor(row: MeetingHistory): SessionReservation {
  return {
    guildId: row.guildId,
    meetingId: row.meetingId,
    ownerInstanceId: WORKER_A,
    executionVersion: 1,
    voiceOperationAttemptId: "synthetic-attempt",
    reservedAt: NOW,
    sessionMode: "meeting",
    historyKey: keyOf(row),
  };
}

export function leaseFor(
  meetingId: string,
  leaseExpiresAt: number,
): ActiveMeetingLease {
  return {
    guildId: GUILD,
    meetingId,
    ownerInstanceId: WORKER_A,
    voiceChannelId: "synthetic-voice",
    textChannelId: "synthetic-text",
    isAutoRecording: false,
    leaseExpiresAt,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: leaseExpiresAt + 1,
    sessionMode: "meeting",
    voiceOperationAttemptId: "synthetic-attempt",
    executionVersion: 1,
  };
}

export const capturePatch = {
  capture: {
    kind: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
  },
  endReason: "button",
  endTriggeredByUserId: "synthetic-user",
  duration: 600,
} satisfies Parameters<MeetingFinishRepository["recordCaptureEnd"]>[0]["patch"];

export const derivedEnd = {
  capture: {
    kind: "interrupted",
    startedAt: "2026-01-01T00:00:00.000Z",
    detectedAt: "2026-01-01T00:20:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
  },
  endReason: "unknown",
  duration: 300,
} satisfies Parameters<MeetingFinishRepository["adopt"]>[2];

export async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

export type SeedHistory = (
  id: string,
  overrides?: Partial<MeetingHistory>,
) => Promise<MeetingHistory>;

/** What each part of the contract runs against: the running test's harness and a seeding helper. */
export interface ContractContext {
  h: MeetingFinishHarness;
  seed: SeedHistory;
}
