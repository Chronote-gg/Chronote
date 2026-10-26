import { Center, Stack, Text } from "@mantine/core";
import { MeetingCaptureNotice } from "./MeetingCaptureNotice";
import type { MeetingCapturePresentation } from "../../utils/meetingCaptureNotice";
import type { useLiveMeetingStream } from "../hooks/useLiveMeetingStream";

export function LiveMeetingOutcome({
  status,
  meeting,
}: {
  status: ReturnType<typeof useLiveMeetingStream>["status"];
  meeting?: Omit<MeetingCapturePresentation, "status"> | null;
}) {
  return (
    <Stack gap="sm">
      {meeting ? <MeetingCaptureNotice {...meeting} /> : null}
      {status === "error" || status === "unavailable" ? (
        <Center py="sm">
          <Text size="sm" c="dimmed">
            {status === "unavailable"
              ? "Recording status unavailable. Check the meeting library for saved content and recovery status."
              : "Unable to connect. Check your access to the voice channel and try again."}
          </Text>
        </Center>
      ) : null}
    </Stack>
  );
}
