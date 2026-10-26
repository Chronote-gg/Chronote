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

/** Only a complete atomic cancellation proves that no transaction item was written. */
export function completeConditionalCancellation(
  error: unknown,
  itemCount: number,
) {
  const parsed = errorSchema.safeParse(error);
  if (!parsed.success || parsed.data.name !== "TransactionCanceledException")
    return undefined;
  const reasons = parsed.data.CancellationReasons;
  if (
    !reasons ||
    reasons.length !== itemCount ||
    reasons.some(
      (reason) =>
        reason.Code !== "None" && reason.Code !== "ConditionalCheckFailed",
    ) ||
    !reasons.some((reason) => reason.Code === "ConditionalCheckFailed")
  )
    return undefined;
  return reasons;
}

export function sessionReservationFailure(
  error: unknown,
  input: SessionReservationInput,
): SessionReservationWriteResult {
  const count = input.scope?.kind === "fixture" ? 3 : 2;
  const reasons = completeConditionalCancellation(
    error,
    count +
      2 +
      Number(Boolean(input.history)) +
      Number(Boolean(input.suppression)),
  );
  if (!reasons) return { kind: "blocked", reason: "unavailable" };
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
