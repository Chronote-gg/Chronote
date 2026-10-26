import type {
  SessionReservationInput,
  SessionReservationWriteResult,
} from "../types/deploymentControl";
import { z } from "zod";
export type ConditionalResult = "applied" | "stale";
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
export class DeploymentControlError extends Error {
  constructor(
    public readonly kind: "conflict" | "unavailable",
    public readonly cause: unknown,
  ) {
    super(`Deployment control ${kind}`);
  }
}
export async function conditional(
  operation: () => Promise<unknown>,
): Promise<ConditionalResult> {
  try {
    await operation();
    return "applied";
  } catch (error) {
    const kind = classifyDeploymentTransactionError(error);
    if (kind === "stale") return "stale";
    throw new DeploymentControlError(kind, error);
  }
}

export function sessionReservationFailure(
  error: unknown,
  input: SessionReservationInput,
): SessionReservationWriteResult {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success || classifyDeploymentTransactionError(error) !== "stale")
    return { kind: "blocked", reason: "unavailable" };
  const reasons = parsed.data.CancellationReasons ?? [];
  const failed = (index: number) =>
    reasons[index]?.Code === "ConditionalCheckFailed";
  if (failed(0) || failed(1)) return { kind: "blocked", reason: "not_serving" };
  if (failed(3)) return { kind: "blocked", reason: "voice_uncertain" };
  if (failed(2) || (input.history && failed(4)))
    return { kind: "blocked", reason: "active_session" };
  if (input.suppression && failed(input.history ? 5 : 4))
    return { kind: "blocked", reason: "suppressed" };
  return { kind: "blocked", reason: "unavailable" };
}
