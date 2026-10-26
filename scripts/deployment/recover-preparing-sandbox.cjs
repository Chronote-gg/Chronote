"use strict";
const assert = require("node:assert/strict");
const {
  assertNoEndpointOverride,
  authenticateOperation,
  guardedCoordinator,
  operationOptions,
  awaitSourceRefresh,
  assertPreservedHistory,
} = require("./sandbox-operation.cjs");
const { createCoordinator, configuration } = require("./coordinator.cjs");
const { bindingHash } = require("./binding-hash.cjs");
const { readPreparingProof } = require("./preparing-recovery-proof.cjs");
const {
  createPreparingInspection,
} = require("./preparing-recovery-inspection.cjs");
const {
  buildPreparingRecovery,
  commitPreparingRecovery,
} = require("./preparing-recovery-state.cjs");
const { createCarryforwardAuthority } = require("./carryforward-authority.cjs");
const { runRecoveryCli } = require("./recover-sandbox.cjs");
async function promoteHealthy({ deployment, inspector, claim, now, sleep }) {
  const deadline = now() + 900;
  while (now() <= deadline) {
    try {
      return await deployment.promote();
    } catch (error) {
      if (
        error.category !== "routing_unconfirmed" ||
        error.message !== "Routing destination target is not healthy"
      )
        throw error;
      // Only pre-promotion ALB health may wait; both source and candidate must become healthy.
      const current = await inspector.control();
      assert.equal(current.coordinatorToken, claim.next.coordinatorToken);
      assert.equal(current.coordinatorEpoch, claim.next.coordinatorEpoch);
      assert.equal(
        current.deployment.taskDefinition,
        claim.next.deployment.taskDefinition,
      );
      assert.equal(current.deployment.phase, "warming");
      assert.equal(current.deployment.candidate, undefined);
      assert.equal(current.deployment.routing.state, "source");
      await sleep(10000);
    }
  }
  throw new Error(
    "Candidate ALB health timeout; preserve recovery receipt and source",
  );
}
async function recoverPreparingSandbox(options = {}) {
  const env = options.env ?? process.env,
    now = options.now ?? (() => Math.floor(Date.now() / 1000));
  assertNoEndpointOverride(env);
  assert.ok(["inspect", "recover"].includes(options.mode));
  const { proof, manifest, executionRunToken } = readPreparingProof(env, now);
  const { aws, actor, types, inventory } = await authenticateOperation(
    options,
    env,
    executionRunToken,
  );
  const base = operationOptions(options, {
    env,
    manifest,
    runToken: proof.logicalRunToken,
    aws,
    types,
    now,
  });
  const configEnv = base.env,
    config = configuration(configEnv);
  const coordinator = createCoordinator(base);
  const inspector = createPreparingInspection({
    ...base,
    coordinator,
    config,
    manifest,
    proof,
    manifestSha256: env.CARRYFORWARD_MANIFEST_SHA256,
    originalExecution: options.originalExecution ?? inventory.originalExecution,
  });
  const observed = await inspector.inspect();
  if (options.mode === "inspect")
    return {
      kind: "inspection",
      binding: observed.binding,
      bindingSha256: observed.bindingSha256,
    };
  assert.equal(env.CONTINUATION_BINDING_SHA256, observed.bindingSha256);
  await inventory.assertExclusive();
  const fresh = await inspector.inspect();
  assert.equal(fresh.bindingSha256, observed.bindingSha256);
  await inventory.assertExclusive();
  assert.ok(proof.approveBefore > now());
  assert.ok(fresh.nativeProtectionExpiresAt > now() + 120);
  const claim = buildPreparingRecovery({
    observed: fresh,
    proof,
    proofSha256: env.PREPARING_RECOVERY_PROOF_SHA256,
    executionRunToken,
    actorArn: actor.Arn,
    now: now(),
    types,
    builders:
      options.builders ??
      require("../../dist/services/deploymentControlTransactions.js"),
  });
  await commitPreparingRecovery({ aws, inspector, claim });
  const authority = createCarryforwardAuthority({
    aws,
    inspector,
    config,
    env: configEnv,
    types,
    now,
    runToken: proof.logicalRunToken,
    claim,
    recovery: fresh.recovery,
    fixedTaskDefinition: proof.definitionArn,
  });
  async function beforeMutation(operation, input) {
    assert.notEqual(
      operation,
      "register-task-definition",
      "Preparing recovery never registers a task definition",
    );
    if (
      [
        "update-item",
        "transact-write-items",
        "update-service",
        "modify-listener",
      ].includes(operation)
    ) {
      const current = await inspector.control();
      assert.equal(current.deployment.taskDefinition, proof.definitionArn);
      assert.deepEqual(
        await inspector.read(claim.receipt.pk, claim.receipt.sk),
        claim.receipt,
      );
      const actual = (
        await aws("ecs", "describe-task-definition", {
          taskDefinition: proof.definitionArn,
        })
      ).taskDefinition;
      assert.equal(actual.taskDefinitionArn, proof.definitionArn);
      assert.equal(actual.status, "ACTIVE");
      assert.equal(
        bindingHash(
          require("./task-definition.cjs").taskDefinitionInput(actual),
        ),
        proof.definitionSha256,
      );
      if (operation === "update-service")
        assert.equal(input.taskDefinition, proof.definitionArn);
      await inventory.assertExclusive();
      await authority.assertBeforeWrite(operation, input);
    }
  }
  const deployment = guardedCoordinator(base, beforeMutation);
  await awaitSourceRefresh(
    deployment,
    fresh.source,
    claim.next.coordinatorEpoch,
    options.sleep,
  );
  assert.equal((await deployment.prepare()).kind, "warming");
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  assert.equal(
    (await promoteHealthy({ deployment, inspector, claim, now, sleep })).kind,
    "promoted",
  );
  assert.equal((await deployment.retire()).kind, "complete");
  const completed = await inspector.control();
  assert.equal(completed.coordinatorToken, proof.logicalRunToken);
  assert.equal(completed.coordinatorEpoch, claim.next.coordinatorEpoch);
  assert.equal(completed.deployment.phase, "complete");
  assert.equal(completed.deployment.taskDefinition, proof.definitionArn);
  await assertPreservedHistory(inspector, claim);
  assert.deepEqual(
    await inspector.read(claim.receipt.pk, claim.receipt.sk),
    claim.receipt,
  );
  return {
    kind: "preparing_recovery_complete",
    settlement: "lost_owner_settlement_pending",
    bindingSha256: fresh.bindingSha256,
  };
}
module.exports = { recoverPreparingSandbox };
if (require.main === module)
  runRecoveryCli(
    recoverPreparingSandbox,
    process.argv[2],
    "sandbox_preparing_recovery_failed",
  );
