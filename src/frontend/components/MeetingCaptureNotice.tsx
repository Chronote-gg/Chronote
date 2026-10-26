import { Stack, Text } from "@mantine/core";
import {
  formatMeetingCaptureNotice,
  type MeetingCapturePresentation,
} from "../../utils/meetingCaptureNotice";

export function MeetingCaptureNotice(props: MeetingCapturePresentation) {
  const notice = props.captureNotice ?? formatMeetingCaptureNotice(props);
  if (!notice && !props.recoveryNotice) return null;
  return (
    <Stack gap="xs">
      {notice ? (
        <Text role="alert" c="yellow">
          {notice}
        </Text>
      ) : null}
      {props.recoveryNotice ? (
        <Text role="status" c="dimmed">
          {props.recoveryNotice}
        </Text>
      ) : null}
    </Stack>
  );
}
