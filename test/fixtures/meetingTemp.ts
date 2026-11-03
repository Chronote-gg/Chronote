import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getMeetingTempDir,
  getTempBaseDir,
} from "../../src/services/tempFileService";

export async function removeGeneratedMeetingTemp(meeting: {
  meetingId: string;
}) {
  const directory = path.resolve(getMeetingTempDir(meeting));
  const relative = path.relative(path.resolve(getTempBaseDir()), directory);
  if (
    !meeting.meetingId.startsWith("generated-") ||
    path.basename(directory) !== meeting.meetingId ||
    relative !== path.join("m", meeting.meetingId)
  )
    throw new Error("Unexpected generated test directory");
  await fs.rm(directory, { recursive: true, force: true });
}
