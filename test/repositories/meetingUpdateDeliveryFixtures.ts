import type { MeetingHistory } from "../../src/types/db";
import type { MeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import {
  history,
  pointers,
  planDelivery,
  postOperation,
  registerOperation,
  verifiedState,
  now,
} from "../types/meetingUpdateDelivery.fixture";
export function deliveryRow(
  delivery: MeetingUpdateDelivery,
): MeetingHistory & { updateDelivery: MeetingUpdateDelivery } {
  return {
    ...history(),
    ...pointers,
    contentRevision: 1,
    updateDelivery: delivery,
  };
}
export function paginationPlan(mode: "grow" | "retire") {
  const created = { kind: "created", operationId: "post" };
  const slots =
    mode === "grow"
      ? [{ kind: "existing", messageId: pointers.notesMessageIds[0] }, created]
      : [created];
  return planDelivery(
    [
      { ...postOperation, operationId: "post" },
      { ...registerOperation(true), slots },
    ],
    [
      {
        ...verifiedState("created-message"),
        submissionId: "post",
        submittedAt: now - 2,
        verifiedAt: now - 1,
      },
      mode === "grow"
        ? { kind: "submitted", submissionId: "register", submittedAt: now }
        : { kind: "prepared" },
    ],
  );
}
