import { z } from "zod";
import type {
  SessionReservationInput,
  SessionReservationWriteResult,
} from "../types/deploymentControl";
const errorSchema = z.object({
  name: z.string().optional(),
  CancellationReasons: z
    .array(z.object({ Code: z.string().optional() }))
    .optional(),
});
export function classifyDeploymentTransactionError(
  error: unknown,
): "stale" | "conflict" | "unavailable" {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success) return "unavailable";
  const { name, CancellationReasons: reasons } = parsed.data;
  if (name === "ConditionalCheckFailedException") return "stale";
  if (name === "TransactionConflictException") return "conflict";
  if (name !== "TransactionCanceledException" || !reasons?.length)
    return "unavailable";
  if (
    reasons.some(
      (reason) =>
        !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(
          reason.Code ?? "",
        ),
    )
  )
    return "unavailable";
  if (reasons.some((reason) => reason.Code === "TransactionConflict"))
    return "conflict";
  return reasons.some((reason) => reason.Code === "ConditionalCheckFailed")
    ? "stale"
    : "unavailable";
}

export function sessionReservationFailure(
  error: unknown,
  input: SessionReservationInput,
): SessionReservationWriteResult {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success || classifyDeploymentTransactionError(error) !== "stale")
    return { kind: "blocked", reason: "unavailable" };
  const reasons = parsed.data.CancellationReasons ?? [];
  const count = input.scope?.kind === "fixture" ? 3 : 2;
  const failed = (index: number) =>
    reasons[index]?.Code === "ConditionalCheckFailed";
  if (
    reasons
      .slice(0, count)
      .some((reason) => reason.Code === "ConditionalCheckFailed")
  )
    return { kind: "blocked", reason: "not_serving" };
  if (failed(count + 1)) return { kind: "blocked", reason: "voice_uncertain" };
  if (failed(count) || (input.history && failed(count + 2)))
    return { kind: "blocked", reason: "active_session" };
  if (input.suppression && failed(count + (input.history ? 3 : 2)))
    return { kind: "blocked", reason: "suppressed" };
  return { kind: "blocked", reason: "unavailable" };
}
