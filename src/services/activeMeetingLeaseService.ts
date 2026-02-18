import {
  getActiveMeetingLease,
  requestActiveMeetingEnd,
  releaseActiveMeetingLease,
  renewActiveMeetingLease,
  tryAcquireActiveMeetingLease,
} from "../db";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
  resolveMeetingStatus,
} from "../types/meetingLifecycle";
import type { ActiveMeetingLease } from "../types/db";
import type { MeetingData } from "../types/meeting-data";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

const ACTIVE_MEETING_LEASE_SECONDS = 30;
const ACTIVE_MEETING_HEARTBEAT_MS = 10_000;
const ACTIVE_MEETING_TTL_GRACE_SECONDS = 120;

type AcquireMeetingLeaseInput = {
  guildId: string;
  meetingId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId: string;
  isAutoRecording: boolean;
  startReason?: ActiveMeetingLease["startReason"];
  startTriggeredByUserId?: string;
  autoRecordRule?: ActiveMeetingLease["autoRecordRule"];
};

type MeetingLeaseSnapshotUpdate = {
  status: ActiveMeetingLease["status"];
  endReason?: ActiveMeetingLease["endReason"];
  endTriggeredByUserId?: ActiveMeetingLease["endTriggeredByUserId"];
  cancellationReason?: ActiveMeetingLease["cancellationReason"];
  endedAt?: ActiveMeetingLease["endedAt"];
};

function buildMeetingLeaseSnapshot(
  meeting: MeetingData,
): MeetingLeaseSnapshotUpdate {
  const status = resolveMeetingStatus({
    cancelled: meeting.cancelled,
    finished: meeting.finished,
    finishing: meeting.finishing,
  });

  const snapshot: MeetingLeaseSnapshotUpdate = {
    status,
    endReason: meeting.endReason,
    endTriggeredByUserId: meeting.endTriggeredByUserId,
    cancellationReason: meeting.cancellationReason,
  };

  if (
    status === MEETING_STATUS.CANCELLED ||
    status === MEETING_STATUS.COMPLETE
  ) {
    snapshot.endedAt =
      meeting.endTime?.toISOString() ?? new Date().toISOString();
  }

  return snapshot;
}

function buildLeaseTimestamps(nowMs: number): {
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt: number;
  expiresAt: number;
  nowEpochSeconds: number;
} {
  const createdAt = new Date(nowMs).toISOString();
  const nowEpochSeconds = Math.floor(nowMs / 1000);
  const leaseExpiresAt = nowEpochSeconds + ACTIVE_MEETING_LEASE_SECONDS;
  const expiresAt = leaseExpiresAt + ACTIVE_MEETING_TTL_GRACE_SECONDS;
  return {
    createdAt,
    updatedAt: createdAt,
    leaseExpiresAt,
    expiresAt,
    nowEpochSeconds,
  };
}

export function getCurrentMeetingLeaseOwnerInstanceId(): string {
  return getRuntimeInstanceId();
}

export function isLeaseActive(
  lease: ActiveMeetingLease,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return lease.leaseExpiresAt >= nowEpochSeconds;
}

export async function getActiveMeetingLeaseForGuild(
  guildId: string,
): Promise<ActiveMeetingLease | undefined> {
  return getActiveMeetingLease(guildId);
}

export async function tryAcquireMeetingLease({
  guildId,
  meetingId,
  voiceChannelId,
  voiceChannelName,
  textChannelId,
  isAutoRecording,
  startReason,
  startTriggeredByUserId,
  autoRecordRule,
}: AcquireMeetingLeaseInput): Promise<boolean> {
  const nowMs = Date.now();
  const { createdAt, updatedAt, leaseExpiresAt, expiresAt, nowEpochSeconds } =
    buildLeaseTimestamps(nowMs);
  const leaseRecord: ActiveMeetingLease = {
    guildId,
    meetingId,
    ownerInstanceId: getRuntimeInstanceId(),
    voiceChannelId,
    voiceChannelName,
    textChannelId,
    isAutoRecording,
    status: MEETING_STATUS.IN_PROGRESS,
    leaseExpiresAt,
    createdAt,
    updatedAt,
    expiresAt,
  };
  if (startReason) {
    leaseRecord.startReason = startReason;
  }
  if (startTriggeredByUserId) {
    leaseRecord.startTriggeredByUserId = startTriggeredByUserId;
  }
  if (autoRecordRule) {
    leaseRecord.autoRecordRule = autoRecordRule;
  }

  return tryAcquireActiveMeetingLease(leaseRecord, nowEpochSeconds);
}

export async function releaseMeetingLeaseForMeeting(
  meeting: MeetingData,
): Promise<boolean> {
  stopMeetingLeaseHeartbeat(meeting);
  if (!meeting.leaseOwnerInstanceId) {
    return true;
  }
  return releaseActiveMeetingLease(
    meeting.guildId,
    meeting.meetingId,
    meeting.leaseOwnerInstanceId,
  );
}

export async function releaseMeetingLeaseByIdentifiers(
  guildId: string,
  meetingId: string,
  ownerInstanceId: string,
): Promise<boolean> {
  return releaseActiveMeetingLease(guildId, meetingId, ownerInstanceId);
}

export async function requestMeetingEndViaLease(
  guildId: string,
  meetingId: string,
  requestedByUserId: string,
): Promise<boolean> {
  return requestActiveMeetingEnd(
    guildId,
    meetingId,
    requestedByUserId,
    new Date().toISOString(),
  );
}

async function renewMeetingLeaseForMeeting(
  meeting: MeetingData,
): Promise<boolean> {
  if (!meeting.leaseOwnerInstanceId) {
    return false;
  }
  const nowMs = Date.now();
  const { updatedAt, leaseExpiresAt, expiresAt } = buildLeaseTimestamps(nowMs);
  return renewActiveMeetingLease(
    meeting.guildId,
    meeting.meetingId,
    meeting.leaseOwnerInstanceId,
    leaseExpiresAt,
    updatedAt,
    expiresAt,
    buildMeetingLeaseSnapshot(meeting),
  );
}

export function stopMeetingLeaseHeartbeat(meeting: MeetingData) {
  if (!meeting.leaseHeartbeatTimer) {
    return;
  }
  clearInterval(meeting.leaseHeartbeatTimer);
  meeting.leaseHeartbeatTimer = undefined;
}

function hasLeaseOwnership(
  lease: ActiveMeetingLease | undefined,
  meeting: MeetingData,
): lease is ActiveMeetingLease {
  return Boolean(
    lease &&
    lease.meetingId === meeting.meetingId &&
    lease.ownerInstanceId === meeting.leaseOwnerInstanceId,
  );
}

function shouldIgnoreLeaseOwnershipLoss(meeting: MeetingData): boolean {
  return meeting.finishing || meeting.finished || !meeting.onEndMeeting;
}

async function endMeetingFromLeaseOwnershipLoss(
  meeting: MeetingData,
): Promise<void> {
  const onEndMeeting = meeting.onEndMeeting;
  if (shouldIgnoreLeaseOwnershipLoss(meeting) || !onEndMeeting) {
    return;
  }
  console.warn("Meeting lease ownership record changed, ending meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
  });
  stopMeetingLeaseHeartbeat(meeting);
  meeting.endReason = MEETING_END_REASONS.UNKNOWN;
  await onEndMeeting(meeting);
}

async function processRemoteEndRequest(
  lease: ActiveMeetingLease,
  meeting: MeetingData,
): Promise<boolean> {
  const onEndMeeting = meeting.onEndMeeting;
  if (
    !lease.endRequestedAt ||
    !lease.endRequestedByUserId ||
    meeting.finishing ||
    meeting.finished ||
    !onEndMeeting
  ) {
    return false;
  }
  console.log("Processing remote end request for active meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
    requestedBy: lease.endRequestedByUserId,
  });
  stopMeetingLeaseHeartbeat(meeting);
  meeting.endReason = MEETING_END_REASONS.WEB_UI;
  meeting.endTriggeredByUserId = lease.endRequestedByUserId;
  await onEndMeeting(meeting);
  return true;
}

async function processLeaseRenewalOwnershipLoss(
  meeting: MeetingData,
): Promise<void> {
  const onEndMeeting = meeting.onEndMeeting;
  console.warn("Meeting lease renewal lost ownership, ending meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
  });
  stopMeetingLeaseHeartbeat(meeting);
  if (shouldIgnoreLeaseOwnershipLoss(meeting) || !onEndMeeting) {
    return;
  }
  meeting.endReason = MEETING_END_REASONS.UNKNOWN;
  await onEndMeeting(meeting);
}

export function startMeetingLeaseHeartbeat(meeting: MeetingData) {
  stopMeetingLeaseHeartbeat(meeting);
  if (!meeting.leaseOwnerInstanceId) {
    return;
  }

  const tick = async () => {
    if (meeting.finished) {
      stopMeetingLeaseHeartbeat(meeting);
      return;
    }

    try {
      const lease = await getActiveMeetingLeaseForGuild(meeting.guildId);
      if (!hasLeaseOwnership(lease, meeting)) {
        await endMeetingFromLeaseOwnershipLoss(meeting);
        return;
      }

      const handledRemoteEndRequest = await processRemoteEndRequest(
        lease,
        meeting,
      );
      if (handledRemoteEndRequest) {
        return;
      }

      const renewed = await renewMeetingLeaseForMeeting(meeting);
      if (renewed) {
        return;
      }
      await processLeaseRenewalOwnershipLoss(meeting);
    } catch (error) {
      console.error("Meeting lease renewal failed", {
        guildId: meeting.guildId,
        meetingId: meeting.meetingId,
        error,
      });
    }
  };

  let tickInProgress = false;

  const runTick = async () => {
    if (meeting.finished) {
      stopMeetingLeaseHeartbeat(meeting);
      return;
    }
    if (tickInProgress) {
      return;
    }
    tickInProgress = true;
    try {
      await tick();
    } finally {
      tickInProgress = false;
    }
  };

  meeting.leaseHeartbeatTimer = setInterval(() => {
    void runTick();
  }, ACTIVE_MEETING_HEARTBEAT_MS);
  meeting.leaseHeartbeatTimer.unref?.();
}
