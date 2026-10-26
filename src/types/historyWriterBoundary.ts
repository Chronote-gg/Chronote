import type { PurchaseAttempt } from "./purchase";
import { ledgerWriterDeploymentSchema } from "./ledgerWriterDeployment";
import { z } from "zod";
export const HISTORY_WRITER_VERSION = "offer-ledger-v1";
const boundaryBase = z
  .object({
    accountId: z.string().min(1),
    mode: z.enum(["live", "test"]),
    revision: z.string().min(1),
    writerVersion: z.literal(HISTORY_WRITER_VERSION),
    state: z.literal("verified"),
    cutoverAt: z.number().int().nonnegative(),
    verifiedAt: z.number().int().nonnegative(),
    deploymentReceiptId: z.string().min(1),
    deployment: ledgerWriterDeploymentSchema,
    sample: z
      .object({
        guildId: z.string().regex(/^\d{17,20}$/),
        attemptId: z.string().min(1),
        revision: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export const historyWriterBoundarySchema = boundaryBase.refine(
  (record) => record.verifiedAt >= record.cutoverAt,
  "Writer boundary predates its acceptance",
);
export type HistoryWriterBoundary = z.infer<typeof historyWriterBoundarySchema>;
export function historyWriterBoundaryKey(
  accountId: string,
  mode: "live" | "test",
): string {
  boundaryBase.pick({ accountId: true, mode: true }).parse({ accountId, mode });
  return `OFFER_WRITER#${mode}#${encodeURIComponent(accountId)}`;
}

export function validateBoundarySample(
  next: HistoryWriterBoundary,
  expected: HistoryWriterBoundary | undefined,
  sample: PurchaseAttempt,
) {
  historyWriterBoundarySchema.parse(next);
  if (expected) historyWriterBoundarySchema.parse(expected);
  const witness = sample.writerWitness;
  if (
    !witness ||
    sample.state !== "completed" ||
    sample.incidentKey ||
    sample.mode !== next.mode ||
    sample.guildId !== next.sample.guildId ||
    sample.attemptId !== next.sample.attemptId ||
    sample.revision !== next.sample.revision ||
    witness.writerVersion !== next.writerVersion ||
    witness.imageDigest !== next.deployment.imageDigest ||
    !next.deployment.taskArns.includes(witness.taskArn)
  )
    throw new Error("Writer boundary does not match a normal purchase witness");
  validateBoundaryRevision(next, expected);
}

function validateBoundaryRevision(
  next: HistoryWriterBoundary,
  expected: HistoryWriterBoundary | undefined,
) {
  if (
    expected &&
    (historyWriterBoundaryKey(next.accountId, next.mode) !==
      historyWriterBoundaryKey(expected.accountId, expected.mode) ||
      next.revision === expected.revision ||
      next.cutoverAt < expected.cutoverAt ||
      next.verifiedAt < expected.verifiedAt)
  )
    throw new Error("Writer boundary revision or scope mismatch");
}
