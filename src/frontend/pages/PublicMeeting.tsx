import { PublicMeetingView } from "../features/meetingShares/PublicMeetingView";
import { useMeetingSharePageState } from "../features/meetingShares/useMeetingSharePageState";

export default function PublicMeeting() {
  const state = useMeetingSharePageState();

  return (
    <PublicMeetingView
      meeting={state.meeting}
      share={state.share}
      isLoading={state.isLoading}
      hasError={state.hasError}
      needsAuthHint={state.needsAuthHint}
    />
  );
}
