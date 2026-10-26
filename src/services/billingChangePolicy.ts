import type { BillingInterval, PaidTier } from "../types/pricing";

export function resolveChangeTiming(input: {
  sourceTier: PaidTier;
  sourceInterval: BillingInterval;
  targetTier: PaidTier | "free";
  targetInterval: BillingInterval;
}): "unchanged" | "immediate" | "renewal" {
  if (
    input.sourceTier === input.targetTier &&
    input.sourceInterval === input.targetInterval
  )
    return "unchanged";
  if (
    input.targetTier === "free" ||
    (input.sourceTier === "pro" && input.targetTier === "basic")
  )
    return "renewal";
  if (input.sourceTier === "basic" && input.targetTier === "pro")
    return "immediate";
  return input.targetInterval === "year" ? "immediate" : "renewal";
}
