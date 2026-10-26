import type { PersonalMediaUploadJobRecord } from "../types/db";
import type { Participant } from "../types/participants";
import { buildPersonalMeetingGuildId } from "../utils/meetingOwnership";
export const PERSONAL_UPLOAD_CHANNEL_ID = "personal";
export const buildJobMeetingKey = (job: PersonalMediaUploadJobRecord) => {
  const timestamp = job.createdAt;
  return {
    guildId: buildPersonalMeetingGuildId(job.ownerUserId),
    channelIdTimestamp: `${PERSONAL_UPLOAD_CHANNEL_ID}#${timestamp}`,
    meetingId: job.meetingId ?? job.uploadId,
    timestamp,
  };
};

export const buildPersonalUploadParticipants = (
  job: PersonalMediaUploadJobRecord,
): Participant[] => [
  {
    id: job.ownerUserId,
    username: "Me",
    displayName: "Me",
  },
];
