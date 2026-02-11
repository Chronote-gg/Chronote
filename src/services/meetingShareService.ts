import { randomBytes } from "crypto";
import { getMeetingShareRepository } from "../repositories/meetingShareRepository";
import type {
  MeetingShareByMeetingRecord,
  MeetingShareRecord,
  MeetingShareVisibility,
} from "../types/db";
import { nowIso } from "../utils/time";

export type MeetingShareVisibilityInput = "private" | MeetingShareVisibility;

export type MeetingShareState = {
  visibility: MeetingShareVisibilityInput;
  shareId?: string;
  sharedAt?: string;
  sharedByUserId?: string;
  sharedByTag?: string;
  rotated: boolean;
};

const buildPartitionKey = (guildId: string) => `GUILD#${guildId}`;
const buildShareSortKey = (shareId: string) => `SHARE#${shareId}`;
const buildMeetingSortKey = (meetingId: string) => `MEETING#${meetingId}`;

const generateShareId = () => randomBytes(32).toString("base64url");

const buildShareRecord = (options: {
  guildId: string;
  meetingId: string;
  shareId: string;
  visibility: MeetingShareVisibility;
  sharedAt: string;
  sharedByUserId: string;
  sharedByTag?: string;
  rotatedAt?: string;
}): MeetingShareRecord => ({
  pk: buildPartitionKey(options.guildId),
  sk: buildShareSortKey(options.shareId),
  type: "meetingShare",
  guildId: options.guildId,
  meetingId: options.meetingId,
  shareId: options.shareId,
  visibility: options.visibility,
  sharedAt: options.sharedAt,
  sharedByUserId: options.sharedByUserId,
  sharedByTag: options.sharedByTag,
  rotatedAt: options.rotatedAt,
});

const buildByMeetingRecord = (options: {
  guildId: string;
  meetingId: string;
  shareId: string;
  visibility: MeetingShareVisibility;
  updatedAt: string;
}): MeetingShareByMeetingRecord => ({
  pk: buildPartitionKey(options.guildId),
  sk: buildMeetingSortKey(options.meetingId),
  type: "meetingShareByMeeting",
  guildId: options.guildId,
  meetingId: options.meetingId,
  shareId: options.shareId,
  visibility: options.visibility,
  updatedAt: options.updatedAt,
});

const resolveMissingShareState = (
  visibility: MeetingShareVisibilityInput = "private",
): MeetingShareState => ({
  visibility,
  rotated: false,
});

export async function getMeetingShareStateForMeetingService(params: {
  guildId: string;
  meetingId: string;
}): Promise<MeetingShareState> {
  const repo = getMeetingShareRepository();
  const byMeeting = await repo.getByMeetingId(params.guildId, params.meetingId);
  if (!byMeeting) {
    return resolveMissingShareState("private");
  }
  const share = await repo.getByShareId(params.guildId, byMeeting.shareId);
  if (!share) {
    return resolveMissingShareState("private");
  }
  return {
    visibility: share.visibility,
    shareId: share.shareId,
    sharedAt: share.sharedAt,
    sharedByUserId: share.sharedByUserId,
    sharedByTag: share.sharedByTag,
    rotated: false,
  };
}

export async function setMeetingShareVisibilityService(params: {
  guildId: string;
  meetingId: string;
  visibility: MeetingShareVisibilityInput;
  sharedByUserId: string;
  sharedByTag?: string;
  forceRotate?: boolean;
}): Promise<MeetingShareState> {
  const repo = getMeetingShareRepository();
  const existing = await repo.getByMeetingId(params.guildId, params.meetingId);

  if (params.visibility === "private") {
    if (existing) {
      await repo.delete({
        guildId: params.guildId,
        meetingId: params.meetingId,
        shareId: existing.shareId,
      });
    }
    return resolveMissingShareState("private");
  }

  const requestedVisibility = params.visibility;
  const now = nowIso();

  const shouldReuse =
    existing != null &&
    existing.visibility === requestedVisibility &&
    params.forceRotate !== true;
  const shareId = shouldReuse ? existing.shareId : generateShareId();
  const rotated = Boolean(existing && !shouldReuse);

  if (existing && rotated) {
    await repo.delete({
      guildId: params.guildId,
      meetingId: params.meetingId,
      shareId: existing.shareId,
    });
  }

  const shareRecord = buildShareRecord({
    guildId: params.guildId,
    meetingId: params.meetingId,
    shareId,
    visibility: requestedVisibility,
    sharedAt: now,
    sharedByUserId: params.sharedByUserId,
    sharedByTag: params.sharedByTag,
    rotatedAt: rotated ? now : undefined,
  });
  const byMeetingRecord = buildByMeetingRecord({
    guildId: params.guildId,
    meetingId: params.meetingId,
    shareId,
    visibility: requestedVisibility,
    updatedAt: now,
  });
  await repo.write({ share: shareRecord, byMeeting: byMeetingRecord });

  return {
    visibility: requestedVisibility,
    shareId,
    sharedAt: now,
    sharedByUserId: params.sharedByUserId,
    sharedByTag: params.sharedByTag,
    rotated,
  };
}

export async function getMeetingShareRecordByShareIdService(params: {
  guildId: string;
  shareId: string;
}): Promise<MeetingShareRecord | undefined> {
  return getMeetingShareRepository().getByShareId(
    params.guildId,
    params.shareId,
  );
}
