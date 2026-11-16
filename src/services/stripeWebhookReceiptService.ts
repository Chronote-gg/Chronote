import { randomUUID } from "node:crypto";
import { getStripeWebhookRepository } from "../repositories/stripeWebhookRepository";
import type { RuntimeIdentity } from "../types/deploymentControl";
import {
  getRuntimeInstanceId,
  getWorkerIdentity,
} from "./runtimeInstanceService";
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
/** The stored receipt schema predates the worker registry; its local identity form is the one that needs no deployment proof. */
function workerRuntimeIdentity(instanceId: string): RuntimeIdentity {
  return { kind: "local", localId: instanceId, instanceId, protocolVersion: 1 };
}
/** An unresolved worker identity preserves the authenticated raw receipt without manufacturing a writer. */
export async function receiptBirth(): Promise<StripeReceiptBirth | undefined> {
  try {
    const { instanceId } = await getWorkerIdentity();
    return stripeReceiptBirthSchema.parse({
      version: STRIPE_RECEIPT_BOUNDARY,
      writer: workerRuntimeIdentity(instanceId),
    });
  } catch {
    return undefined;
  }
}
/** The identity a receipt admission records: the worker running it. */
function receiptAdmissionRuntime(): RuntimeIdentity {
  return workerRuntimeIdentity(getRuntimeInstanceId());
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
    () => repo.admit(eventId, token, randomUUID(), receiptAdmissionRuntime()),
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
