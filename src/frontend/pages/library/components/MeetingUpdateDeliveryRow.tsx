import type { MeetingDetails } from "../../../utils/meetingLibrary";
import type { useMeetingUpdateFeedback } from "../hooks/useMeetingUpdateFeedback";
import { MeetingUpdateDeliveryStatus } from "./MeetingUpdateDeliveryStatus";

export function MeetingUpdateDeliveryRow({
  meeting,
  resolveDelivery,
}: {
  meeting: MeetingDetails | null;
  resolveDelivery: ReturnType<
    typeof useMeetingUpdateFeedback
  >["resolveDelivery"];
}) {
  const delivery = resolveDelivery(meeting?.updateDelivery);
  return delivery ? <MeetingUpdateDeliveryStatus delivery={delivery} /> : null;
}
