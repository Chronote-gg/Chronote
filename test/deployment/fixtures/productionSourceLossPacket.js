import {
  bindingHash,
  continuationBinding,
} from "../../../scripts/deployment/continue-sandbox.cjs";
export function syntheticStopEventEvidence(service, event) {
  return {
    kind: "ecs_service_stop_event",
    eventId: event.id,
    eventBodySha256: bindingHash({
      serviceArn: service.serviceArn,
      clusterArn: service.clusterArn,
      ...event,
    }),
    eventCaptureSha256: "c".repeat(64),
    inspectionReceiptSha256: "d".repeat(64),
    historicalPacketCanonicalHash: "e".repeat(64),
    historicalInspectionBindingSha256: "b".repeat(64),
    historicalExecutorCommit: "d19b4fe09885f1f3c65816f89454d2c9e49ed0ff",
    inspectionWindowStart: new Date(950000).toISOString(),
    inspectionWindowEnd: new Date(970000).toISOString(),
  };
}
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
