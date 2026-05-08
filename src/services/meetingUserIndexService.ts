import { getMeetingUserIndexRepository } from "../repositories/meetingUserIndexRepository";
import type { MeetingHistory } from "../types/db";
import { buildMeetingUserIndexRecords } from "../utils/meetingUserIndex";

export async function writeMeetingUserIndexForMeetingService(
  meeting: MeetingHistory,
) {
  const records = buildMeetingUserIndexRecords(meeting);
  if (records.length === 0) return;
  await getMeetingUserIndexRepository().write(records);
}

export async function listMeetingUserIndexForUserInRangeService(
  userId: string,
  startTimestamp: string,
  endTimestamp: string,
  limit?: number,
) {
  return getMeetingUserIndexRepository().listByUserTimestampRange(
    userId,
    startTimestamp,
    endTimestamp,
    limit,
  );
}
