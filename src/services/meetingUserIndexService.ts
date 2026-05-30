import { getMeetingUserIndexRepository } from "../repositories/meetingUserIndexRepository";
import type { MeetingHistory, MeetingUserIndexRecord } from "../types/db";
import { buildMeetingUserIndexRecords } from "../utils/meetingUserIndex";

const buildIndexKey = (
  record: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">,
) => `${record.userId}\u0000${record.userTimestamp}`;

export async function writeMeetingUserIndexForMeetingService(
  meeting: MeetingHistory,
) {
  const records = buildMeetingUserIndexRecords(meeting);
  if (records.length === 0) return;
  await getMeetingUserIndexRepository().write(records);
}

export async function replaceMeetingUserIndexForMeetingService(
  previous: MeetingHistory,
  updated: MeetingHistory,
) {
  const previousRecords = buildMeetingUserIndexRecords(previous);
  const updatedRecords = buildMeetingUserIndexRecords(updated);
  const updatedKeys = new Set(updatedRecords.map(buildIndexKey));
  const staleRecords = previousRecords.filter(
    (record) => !updatedKeys.has(buildIndexKey(record)),
  );
  const repository = getMeetingUserIndexRepository();
  if (staleRecords.length > 0) await repository.delete(staleRecords);
  if (updatedRecords.length > 0) await repository.write(updatedRecords);
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
