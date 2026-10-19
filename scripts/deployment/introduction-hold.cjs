"use strict";
const { isDeepStrictEqual } = require("node:util");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
function modules(options) {
  return (
    options.builders ??
    require("../../dist/services/productionIntroductionTransactions.js")
  );
}
function authorityFor(binding) {
  const m = binding.manifest;
  return {
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: `OPERATION#${m.operationId}`,
    recordType: "introduction_authority",
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    operationId: m.operationId,
    revision: 1,
    actor: binding.actor,
    runToken: m.handoff.priorRunToken,
    validFrom: m.validFrom,
    validUntil: m.validUntil,
    handoff: {
      ...Object.fromEntries(
        Object.entries(m.handoff).filter(([key]) => key !== "grants"),
      ),
      priorDigest: m.runtime.candidateDigest,
      taskDefinition: m.runtime.continuationDefinition,
      imageDigest: m.runtime.continuationDigest,
    },
    actions: Object.fromEntries(
      m.actions.map((a) => [
        a.actionId,
        {
          kind: a.kind,
          intentHash: canonicalHash({
            action: a,
            runtime: m.runtime,
            resources: m.resources,
          }),
        },
      ]),
    ),
  };
}
function createIntroductionHold(options) {
  const builders = modules(options),
    tables = { deploymentControl: options.table };
  async function readState(binding) {
    const manifest = assertBoundExecution(binding, options.now());
    if (options.table !== manifest.resources.tables.deploymentControl)
      throw new Error("introduction_refused");
    const hold = builders.introductionHoldSchema.parse(
      await options.read({ pk: "ENV", sk: "INTRODUCTION" }),
    );
    const expected = authorityFor(binding);
    const authority = builders.introductionAuthoritySchema.parse(
      await options.read({ pk: expected.pk, sk: expected.sk }),
    );
    matchingHold(builders, hold, authority);
    if (!isDeepStrictEqual(authority, expected))
      throw new Error("introduction_refused");
    return { hold, authority };
  }
  return {
    readState,
    async initialize({ binding, control, lineage }) {
      const { hold, authority } = await readState(binding);
      return options.write(
        builders.buildInitializeIntroductionControl({
          hold,
          authority,
          control,
          lineage,
          tables,
        }),
      );
    },
    async authorizeFixture({ binding, expectedControl, operation }) {
      const { hold, authority } = await readState(binding);
      return options.write(
        builders.buildAuthorizeFixtureCoordinator({
          hold,
          authority,
          expectedControl,
          operation,
          tables,
        }),
      );
    },
    async acquire(binding) {
      const m = assertBoundExecution(binding, options.now());
      if (options.table !== m.resources.tables.deploymentControl)
        throw new Error("introduction_refused");
      if (
        binding.manifestHash !== canonicalHash(m) ||
        options.now() < m.validFrom ||
        options.now() >= m.validUntil
      )
        throw new Error("introduction_refused");
      const hold = {
        pk: "ENV",
        sk: "INTRODUCTION",
        recordType: "production_introduction",
        protocolVersion: 1,
        holdId: m.holdId,
        introductionId: m.introductionId,
        manifestHash: binding.manifestHash,
        revision: 1,
        admission: { state: "held" },
        deployment: { state: "held" },
      };
      const authority = authorityFor(binding);
      await options.write(
        builders.buildAcquireIntroductionHold({ hold, authority, tables }),
      );
      return { hold, authority };
    },
  };
}
function matchingHold(builders, hold, authority) {
  builders.introductionHoldSchema.parse(hold);
  if (
    hold.admission.state !== "held" ||
    hold.deployment.state !== "held" ||
    ["holdId", "introductionId", "manifestHash", "revision"].some(
      (key) => hold[key] !== authority[key],
    )
  )
    throw new Error("introduction_refused");
}
function assertIntroductionAction(
  builders,
  hold,
  operationAuthority,
  requestedAction,
  now,
) {
  const authority =
    builders.introductionAuthoritySchema.parse(operationAuthority);
  matchingHold(builders, hold, authority);
  if (
    !Number.isSafeInteger(now) ||
    now < authority.validFrom ||
    now >= authority.validUntil ||
    ["operationId", "actor", "runToken"].some(
      (key) => requestedAction[key] !== authority[key],
    ) ||
    authority.actions[requestedAction.actionId]?.intentHash !==
      requestedAction.intentHash
  )
    throw new Error("introduction_refused");
  return authority;
}
function assertMutationAllowed({
  builders,
  hold,
  operationAuthority,
  requestedAction,
  currentControl,
  now,
}) {
  if (requestedAction.kind === "introduction_action")
    return assertIntroductionAction(
      builders,
      hold,
      operationAuthority,
      requestedAction,
      now,
    );
  const authority =
    builders.fixtureCoordinatorAuthoritySchema.parse(operationAuthority);
  matchingHold(builders, hold, authority);
  const control = builders.controlRecordSchema.parse(currentControl);
  if (
    requestedAction.kind !== "fixture_coordinator" ||
    ["runToken", "candidateId", "taskDefinition", "imageDigest"].some(
      (key) => requestedAction[key] !== authority[key],
    )
  )
    throw new Error("introduction_refused");
  const maintenance = {
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    revision: hold.revision,
  };
  if (
    !isDeepStrictEqual(control.maintenance, maintenance) ||
    control.coordinatorToken !== authority.priorRunToken ||
    control.coordinatorEpoch !== authority.priorEpoch ||
    control.coordinatorExpiresAt !== 0 ||
    control.servingGeneration !== authority.priorGeneration ||
    !isDeepStrictEqual(Object.values(control.servingMembers), [
      authority.priorMember,
    ]) ||
    control.deployment ||
    control.compatibleReplacement
  )
    throw new Error("introduction_refused");
  return authority;
}
module.exports = {
  createIntroductionHold,
  authorityFor,
  modules,
  assertMutationAllowed,
};
