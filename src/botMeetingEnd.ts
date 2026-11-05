import type { Client } from "discord.js";
import type { MeetingData } from "./types/meeting-data";
import { handleEndMeetingOther } from "./commands/endMeeting";

export async function endMeetingWithNotice(
  client: Client,
  meeting: MeetingData,
  content: string,
) {
  // Informational Discord delivery must never hold finalization or voice release open.
  const notice = Promise.resolve()
    .then(() => meeting.textChannel.send(content))
    .catch(() => {
      console.warn("Meeting end notice failed:", { stage: "send" });
    });
  await handleEndMeetingOther(client, meeting);
  if (meeting.isAutoRecording && meeting.cancelled && meeting.finished) {
    void notice
      .then(async (message) => {
        if (message) await message.delete();
      })
      .catch(() => {
        console.warn("Meeting end notice failed:", { stage: "delete" });
      });
  }
}
