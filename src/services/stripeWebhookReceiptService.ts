import { randomUUID } from "node:crypto";
import { getDeploymentControlRepository } from "../db";
import { getStripeWebhookRepository } from "../repositories/stripeWebhookRepository";
import { getRuntimeReadiness } from "./runtimeLifecycleService";
import { sameRuntimeIdentity } from "../types/deploymentControl";
import { introductionHoldSchema } from "../types/productionIntroduction";
import {
  stripeReceiptBirthSchema,
  STRIPE_RECEIPT_BOUNDARY,
  type StripeReceiptBirth,
} from "../types/stripeWebhookReceipt";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
import {
  runBillingReceiptOperation,
  persistBillingAcknowledgment,
  UnresolvedBillingMutation,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
/** Lookup failure preserves the authenticated raw receipt without manufacturing authority. */
export async function receiptBirth(): Promise<StripeReceiptBirth | undefined> {
  try {
    const readiness = getRuntimeReadiness();
    if (!readiness) return undefined;
    const repo = getDeploymentControlRepository();
    const runtime = await repo.getRecord(
      "ENV",
      "RUNTIME#" + readiness.identity.instanceId,
    );
    const control = await repo.getRecord("ENV", "CONTROL");
    if (
      runtime?.recordType !== "runtime" ||
      !sameRuntimeIdentity(runtime.identity, readiness.identity) ||
      control?.recordType !== "control"
    )
      return undefined;
    const hold = control.maintenance;
    if (hold) {
      const intro = introductionHoldSchema.parse(
        await repo.getRecord("ENV", "INTRODUCTION"),
      );
      if (
        intro.holdId !== hold.holdId ||
        intro.introductionId !== hold.introductionId ||
        intro.revision !== hold.revision ||
        intro.admission.state !== "held"
      )
        return undefined;
    }
    return stripeReceiptBirthSchema.parse({
      version: STRIPE_RECEIPT_BOUNDARY,
      writer: readiness.identity,
      ...(hold ? { hold } : {}),
    });
  } catch {
    return undefined;
  }
}
export async function continueStripeReceipt(
  eventId: string,
  token: string,
  handler: (owner: RuntimeBillingOwner) => Promise<void>,
): Promise<void> {
  const repo = getStripeWebhookRepository();
  if (
    !stripeReceiptBirthSchema.safeParse((await repo.get(eventId))?.birth)
      .success
  )
    throw new RuntimeAdmissionUnavailable("Webhook birth is unproven");
  const outcome = await runBillingReceiptOperation(
    "stripe:" + eventId + ":" + token,
    (context) => repo.admit(eventId, token, randomUUID(), context),
    async (owner) => {
      try {
        await handler(owner);
        await owner.settleEffects();
        await persistBillingAcknowledgment(owner, () =>
          repo.finish(eventId, token),
        );
      } catch (error) {
        await owner.settleEffects().catch(() => {
          // Preserve the handler error; its owner still retains unknown tails.
          throw error;
        });
        if (
          !owner.mutationStarted() &&
          !(error instanceof UnresolvedBillingMutation) &&
          !(error instanceof RuntimeAdmissionUnavailable)
        ) {
          await persistBillingAcknowledgment(owner, () =>
            repo.fail(eventId, token),
          );
          return { kind: "failed" as const, error };
        }
        throw error;
      }
    },
  );
  if (outcome?.kind === "failed") throw outcome.error;
}
