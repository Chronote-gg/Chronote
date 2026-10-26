import { randomUUID } from "node:crypto";
import { writerFixture } from "./productionAcceptanceWriters.js";
import { bound, heldIntroduction } from "./productionManifest.js";
import { authorityFor } from "../../scripts/deployment/introduction-hold.cjs";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { introductionHoldSchema } from "../../src/types/productionIntroduction";
import {
  controlRecordSchema,
  runtimeRecordSchema,
} from "../../src/types/deploymentControl";
import {
  introductionActionSchema,
  introductionAuthoritySchema,
} from "../../src/services/productionIntroductionTransactions";
import {
  acceptanceRecordSchema,
  type AcceptancePurpose,
  type FinalAcceptanceInput,
} from "../../src/services/productionAcceptanceTransactions";
import { completeItemSizeBound } from "../../src/services/productionAcceptanceConditions";
import { launcherObservationSchema } from "../../src/services/productionIntroductionHistory";
export function finalFixture(
  purpose: AcceptancePurpose = "persist_acceptance",
  table = "control",
): FinalAcceptanceInput {
  const state = writerFixture(),
    binding = bound(state.m),
    m = binding.manifest;
  const authority = introductionAuthoritySchema.parse(authorityFor(binding));
  const selected = m.actions.find(
    (a: { purpose?: string }) => a.purpose === purpose,
  );
  const hold = introductionHoldSchema.parse({
    ...heldIntroduction(binding),
    fixtureGrantIds: m.handoff.grants.map(
      (g: { grantId: string }) => g.grantId,
    ),
  });
  const control = controlRecordSchema.parse(state.control);
  const acceptance = acceptanceRecordSchema.parse({
    pk: authority.pk,
    sk: "ACCEPTANCE",
    recordType: "production_acceptance",
    protocolVersion: 1,
    acceptanceId: m.actions.find(
      (a: { purpose?: string }) => a.purpose === "persist_acceptance",
    ).actionId,
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    sourceCommit: m.identity.sourceCommit,
    originalRunId: m.identity.runId,
    originalRunAttempt: "1",
    supplementCommit: "a".repeat(40),
    supplementHash: "a".repeat(64),
    fixtureEvidenceHash: "b".repeat(64),
    historyEvidenceHash: "c".repeat(64),
    writerClosureHash: "d".repeat(64),
    retainedDispositionHash: "e".repeat(64),
    launcherBaselineHash: "f".repeat(64),
    handoffAt: new Date(200000).toISOString(),
    retiredAt: 310,
    servingGeneration: control.servingGeneration,
    servingMembersHash: canonicalHash(control.servingMembers),
  });
  if (purpose === "release_deployment") {
    hold.admission = { state: "reopened", receiptId: acceptance.acceptanceId };
    delete control.maintenance;
  }
  const action = introductionActionSchema.parse({
    pk: authority.pk,
    sk: `ACTION#${selected.actionId}`,
    recordType: "introduction_action",
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    manifestHash: hold.manifestHash,
    operationId: authority.operationId,
    revision: 1,
    actor: authority.actor,
    runToken: authority.runToken,
    actionId: selected.actionId,
    kind: "acceptance_write",
    intentHash: authority.actions[selected.actionId].intentHash,
    requestHash: "1".repeat(64),
    predecessor: null,
    reservedAt: 318,
    phase: "submitted",
    version: 2,
    submittedAt: 319,
    attemptId: randomUUID(),
  });
  const launcher = launcherObservationSchema.parse({
    kind: "launcher_settings",
    mode: "zero-external-launcher-mutations",
    manifestHash: hold.manifestHash,
    baselineHash: acceptance.launcherBaselineHash,
    sourceCommit: m.identity.sourceCommit,
    observedAt: 319,
    coverage: [
      "github_routes",
      "github_environment",
      "github_branch",
      "github_variables",
      "github_actions",
      "resumable_jobs",
      "named_roles",
      "oidc",
    ],
  });
  const guards = state.runtimes.map((value: unknown) => {
    const row = runtimeRecordSchema.parse(value);
    return {
      table,
      key: { pk: row.pk, sk: row.sk },
      row,
      fields: [
        ...new Set([
          ...Object.keys(row),
          "workCounts",
          "expiresAt",
          "retirementRequest",
          "retirementAcknowledgment",
        ]),
      ],
      maximumItemBytes: completeItemSizeBound(row),
    };
  });
  return {
    table,
    purpose,
    hold,
    control,
    authority,
    action,
    acceptance,
    guards,
    launcher,
    now: 320,
  };
}
