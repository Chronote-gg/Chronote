import { z } from "zod";

export const RUNTIME_WORK_KINDS = [
  "pending_admission",
  "recording",
  "finalization",
  "personal_processing",
  "recovery_processing",
  "voice_operation",
  "ancillary_delivery",
] as const;
export type RuntimeWorkKind = (typeof RUNTIME_WORK_KINDS)[number];
export const runtimeWorkCountsSchema = z.record(
  z.enum(RUNTIME_WORK_KINDS),
  z.number().int().nonnegative(),
);
const text = z.string().min(1).max(1024);
/** Coordinator record for an outgoing runtime whose ECS task stopped before acknowledging retirement. */
export const retirementContinuationSchema = z
  .object({
    reason: z.literal("outgoing_task_stopped"),
    taskStatus: z.enum(["stopped", "missing"]),
    stoppedReason: text.optional(),
    stoppedAt: z.string().datetime({ offset: true }).optional(),
    lostWorkCounts: runtimeWorkCountsSchema.optional(),
    continuedBy: text,
    continuedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RetirementContinuation = z.infer<
  typeof retirementContinuationSchema
>;
