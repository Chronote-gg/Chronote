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
const { readCarryforwardManifest } = require("./carryforward-manifest.cjs");
const { createCarryforwardAuthority } = require("./carryforward-authority.cjs");
const {
  createCarryforwardInspection,
} = require("./carryforward-inspection.cjs");
const {
  buildCarryforward,
  commitCarryforward,
} = require("./carryforward-state.cjs");
const { runRecoveryCli } = require("./recover-sandbox.cjs");
async function carryforwardSandbox(options = {}) {
  const env = options.env ?? process.env,
    now = options.now ?? (() => Math.floor(Date.now() / 1000));
  assertNoEndpointOverride(env);
  assert.ok(["inspect", "carryforward"].includes(options.mode));
  const { manifest, hash, runToken } = readCarryforwardManifest(env, now);
  const { aws, actor, types, inventory } = await authenticateOperation(
    options,
    env,
    runToken,
  );
  const base = operationOptions(options, {
    env,
    manifest,
    runToken: runToken,
    aws,
    types,
    now,
  });
  const configEnv = base.env,
    config = configuration(configEnv);
  const coordinator = createCoordinator(base);
  const inspector = createCarryforwardInspection({
    ...base,
    coordinator,
    config,
    manifest,
    manifestSha256: hash,
  });
  const observed = await inspector.inspect();
  if (options.mode === "inspect")
    return {
      kind: "inspection",
      binding: observed.binding,
      bindingSha256: observed.bindingSha256,
    };
  assert.equal(env.CARRYFORWARD_BINDING_SHA256, observed.bindingSha256);
  await inventory.assertExclusive();
  const fresh = await inspector.inspect();
  assert.equal(fresh.bindingSha256, observed.bindingSha256);
  await inventory.assertExclusive();
  assert.ok(
    fresh.nativeProtectionExpiresAt > now() + 120,
    "Native protection expired before carryforward commit",
  );
  assert.ok(manifest.approveBefore > now());
  const claim = buildCarryforward({
    manifest,
    manifestSha256: hash,
    bindingSha256: fresh.bindingSha256,
    observed: fresh,
    runToken,
    actorArn: actor.Arn,
    now: now(),
    types,
    builders: options.builders,
  });
  await commitCarryforward({ aws, inspector, claim });
  const authority = createCarryforwardAuthority({
    aws,
    inspector,
    config,
    env: configEnv,
    types,
    now,
    manifest,
    runToken,
    claim,
    recovery: fresh.recovery,
  });
  const deployment = guardedCoordinator(base, async (operation, input) => {
    await inventory.assertExclusive();
    await authority.assertBeforeWrite(operation, input);
  });
  await awaitSourceRefresh(
    deployment,
    fresh.source,
    claim.next.coordinatorEpoch,
    options.sleep,
  );
  assert.equal((await deployment.prepare()).kind, "warming");
  assert.equal((await deployment.promote()).kind, "promoted");
  assert.equal((await deployment.retire()).kind, "complete");
  const completed = await inspector.control();
  assert.equal(completed.coordinatorToken, runToken);
  assert.equal(completed.deployment.phase, "complete");
  await assertPreservedHistory(inspector, {
    archive: claim.archive,
    recovery: fresh.recovery,
  });
  return {
    kind: "carryforward_complete",
    settlement: "lost_owner_settlement_pending",
    bindingSha256: fresh.bindingSha256,
  };
}
module.exports = { carryforwardSandbox };
if (require.main === module)
  runRecoveryCli(
    carryforwardSandbox,
    process.argv[2],
    "sandbox_carryforward_failed",
  );
