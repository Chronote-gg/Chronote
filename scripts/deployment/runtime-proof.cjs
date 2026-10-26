"use strict";
const { sameEcsTaskArn } = require("../../src/utils/ecsTaskArn.js");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const PROTECTION_MARGIN_SECONDS = 120;
function createRuntimeProof({ aws, config, types, now, diagnostic }) {
  const same = types.sameRuntimeIdentity;
  function freshProof(proof, margin = 0) {
    return proof.provenAt <= now() && proof.expiresAt > now() + margin;
  }
  function readyReadiness(r, ctl, mode) {
    return (
      r.runtimeMode === mode &&
      r.observedEpoch === ctl.coordinatorEpoch &&
      r.observedGeneration === ctl.servingGeneration &&
      r.dependenciesReady &&
      r.cacheReady &&
      (mode === "api" || r.gatewayReady) &&
      freshProof(r)
    );
  }
  function ready(row, ctl, identity, mode) {
    const r = row?.readiness;
    return (
      row?.recordType === "runtime" &&
      row.expiresAt === undefined &&
      same(row.identity, identity) &&
      same(r.identity, identity) &&
      same(row.protection.identity, identity) &&
      readyReadiness(r, ctl, mode) &&
      freshProof(row.protection, PROTECTION_MARGIN_SECONDS)
    );
  }
  async function protectedTask(identity) {
    diagnostic.nativeProtection = "unconfirmed";
    if (identity.kind !== "ecs")
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "ECS identity required",
      );
    const result = await aws("ecs", "get-task-protection", {
      cluster: config.cluster,
      tasks: [identity.taskArn],
    });
    diagnostic.operation = "verify_native_protection";
    const proof = result.protectedTasks?.find((task) =>
      sameEcsTaskArn(task.taskArn, identity.taskArn),
    );
    if (
      result.failures?.length ||
      !proof?.protectionEnabled ||
      !Number.isFinite(Date.parse(proof.expirationDate)) ||
      Date.parse(proof.expirationDate) / 1000 <=
        now() + PROTECTION_MARGIN_SECONDS
    )
      throw new CoordinatorFailure(
        "native_protection_unconfirmed",
        "Native task protection unconfirmed; preserve work and investigate capacity/DEPLOYMENT_BLOCKED",
      );
    diagnostic.nativeProtection = "last_check_confirmed";
    return {
      taskArn: proof.taskArn,
      protectionEnabled: true,
      expirationDate: proof.expirationDate,
    };
  }
  return { ready, protectedTask };
}
module.exports = { createRuntimeProof };
