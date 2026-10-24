import {
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
} from "../../src/types/meetingUpdateDelivery";
import {
  planDelivery,
  patchOperation,
  observedAttemptInput,
  verifiedState,
} from "./meetingUpdateDelivery.fixture";
export function knownReadFailure(
  kind: "prepared" | "observed" | "verified",
  attempts: number,
) {
  const base = planDelivery(
    [patchOperation("patch")],
    [kind === "verified" ? verifiedState() : { kind: "prepared" }],
  );
  if (!("attempt" in base.progress))
    throw new Error("Expected claimed fixture");
  return meetingUpdateDeliverySchema.parse({
    ...base,
    attempts,
    progress:
      kind === "observed"
        ? {
            ...base.progress,
            attempt: preparedMeetingUpdateAttemptSchema.parse(
              observedAttemptInput(),
            ),
            operations: [],
          }
        : base.progress,
  });
}
