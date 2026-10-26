import type { ECSClient } from "@aws-sdk/client-ecs";
import { createHash, randomUUID } from "node:crypto";
import { getPurchaseRepository } from "../repositories/purchaseAttemptRepository";
import { getHistoryWriterBoundaryRepository } from "../repositories/historyWriterBoundaryRepository";
import {
  historyWriterBoundarySchema,
  HISTORY_WRITER_VERSION,
  type HistoryWriterBoundary,
} from "../types/historyWriterBoundary";
import { normalPurchaseWriterWitnessSchema } from "../types/normalPurchaseWriterWitness";
import type { StripeClient } from "../types/stripe";
import type { ProviderMode } from "../types/offerUsage";
import { normalPurchaseWriterWitness } from "./normalPurchaseWriterWitness";
import {
  verifyLedgerWriterDeployment,
  type LedgerWriterDeploymentTarget,
} from "./ledgerWriterDeployment";

export async function registerHistoryWriterBoundary(input: {
  stripe: StripeClient;
  ecs: ECSClient;
  accountId: string;
  mode: ProviderMode;
  sampleGuildId: string;
  target: LedgerWriterDeploymentTarget;
  apply?: boolean;
}): Promise<{ kind: "dry_run" | "applied"; boundary: HistoryWriterBoundary }> {
  const [account, balance] = await Promise.all([
    input.stripe.accounts.retrieve(null),
    input.stripe.balance.retrieve(),
  ]);
  if (
    account.id !== input.accountId ||
    balance.livemode !== (input.mode === "live")
  )
    throw new Error("Writer registration provider identity mismatch");
  const sample = await getPurchaseRepository().get(input.sampleGuildId);
  if (
    !sample ||
    sample.mode !== input.mode ||
    sample.state !== "completed" ||
    !sample.subscriptionId ||
    !sample.writerWitness
  )
    throw new Error(
      "A genuine normal paid-purchase writer witness is required",
    );
  const witness = normalPurchaseWriterWitnessSchema.parse(sample.writerWitness);
  const [subscription, invoice] = await Promise.all([
    input.stripe.subscriptions.retrieve(sample.subscriptionId),
    input.stripe.invoices.retrieve(witness.invoiceId),
  ]);
  const verified = normalPurchaseWriterWitness(
    sample,
    subscription,
    invoice,
    witness,
  );
  if (!verified || verified.invoiceId !== witness.invoiceId)
    throw new Error("Writer sample financial scope is not verified");
  const deployment = await verifyLedgerWriterDeployment(
    input.ecs,
    input.target,
    { taskArn: witness.taskArn, imageDigest: witness.imageDigest },
  );
  const repo = getHistoryWriterBoundaryRepository();
  const previous = await repo.get(input.accountId, input.mode);
  const verifiedAt = Date.now();
  const boundary = historyWriterBoundarySchema.parse({
    accountId: input.accountId,
    mode: input.mode,
    revision: randomUUID(),
    writerVersion: HISTORY_WRITER_VERSION,
    state: "verified",
    cutoverAt: verifiedAt,
    verifiedAt,
    deploymentReceiptId: createHash("sha256")
      .update(JSON.stringify({ deployment, witness }))
      .digest("hex"),
    deployment,
    sample: {
      guildId: sample.guildId,
      attemptId: sample.attemptId,
      revision: sample.revision,
    },
  });
  if (!input.apply) return { kind: "dry_run", boundary };
  // Registration changes only the account's boundary record. The sample remains
  // a condition check, and native financial/provider resources are never mutated.
  if (!(await repo.compareAndWrite(boundary, previous, sample)))
    throw new Error("Writer boundary or sample changed; repeat verification");
  return { kind: "applied", boundary };
}
export async function invalidateHistoryWriterBoundary(input: {
  accountId: string;
  mode: ProviderMode;
  expectedRevision: string;
  apply?: boolean;
}): Promise<"dry_run" | "applied" | "absent"> {
  const repo = getHistoryWriterBoundaryRepository();
  const current = await repo.get(input.accountId, input.mode);
  if (!current) return "absent";
  if (current.revision !== input.expectedRevision)
    throw new Error(
      "Writer boundary revision changed; review it before invalidation",
    );
  if (!input.apply) return "dry_run";
  if (!(await repo.remove(current)))
    throw new Error("Writer boundary changed; review it before invalidation");
  return "applied";
}
