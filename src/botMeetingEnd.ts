import type { Client } from "discord.js";
import type { MeetingData } from "./types/meeting-data";
import { handleEndMeetingOther } from "./commands/endMeeting";

/**
 * The notice never holds the close. An auto-recording's notice is handed to
 * the finish, which deletes it if the meeting turns out cancelled.
 */
export async function endMeetingWithNotice(
  client: Client,
  meeting: MeetingData,
  content: string,
) {
  void Promise.resolve()
    .then(() => meeting.textChannel.send(content))
    .then((message) => {
      if (meeting.isAutoRecording)
        meeting.messagesToDelete = [
          ...(meeting.messagesToDelete ?? []),
          message.id,
        ];
    })
    .catch(() => {
      console.warn("Meeting end notice failed:", { stage: "send" });
    });
  await handleEndMeetingOther(client, meeting);
}
