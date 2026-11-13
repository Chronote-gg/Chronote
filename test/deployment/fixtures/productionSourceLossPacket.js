import { continuationBinding } from "../../../scripts/deployment/continue-sandbox.cjs";
export function productionSourceLossPacket(
  control,
  candidate,
  actor,
  executorCommit,
) {
  return {
    version: 1,
    accountId: actor.Account,
    actorArn: actor.Arn,
    region: "us-east-1",
    executorCommit,
    operation: continuationBinding(control, candidate),
    billingFlags: {
      STRIPE_MODE: "live",
      STRIPE_RENEWAL_GRACE_ENABLED: "",
      STRIPE_INTRO_OFFER_LEDGER_ENABLED: "",
      STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED: "",
      STRIPE_RENEWAL_REACTIVATION_ENABLED: "",
    },
  };
}
