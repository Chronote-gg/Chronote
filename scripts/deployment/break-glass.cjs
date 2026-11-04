"use strict";
const { writeFileSync } = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const {
  assertBreakGlassDispatch,
  breakGlassRequested,
} = require("./break-glass-guard.cjs");
/** Preparation must finish well inside the attestation, never at its edge. */
const ATTESTATION_MARGIN_SECONDS = 300;
/** What a break-glass run does not do that the standard path does. */
const SKIPPED_CHECKS = Object.freeze([
  "ci",
  "deploy_docs",
  "handoff_quiet_wait",
  "runtime_preservation_seal",
]);
function refuse(message) {
  throw new CoordinatorFailure("break_glass_refused", message);
}
/**
 * The operator attestation must name the dispatched backup manifest, belong to
 * the outgoing task, be unconsumed, and outlive the preparation.
 */
function verifyBreakGlassAttestation({ row, source, manifestSha256, now }) {
  const attestation = row?.attestation;
  if (!attestation)
    refuse(
      "The outgoing runtime has no operator attestation; run attest-preservation first",
    );
  if (attestation.taskId !== source.taskId)
    refuse("The attestation is bound to another source task");
  if (row.state !== "attested_legacy")
    refuse("Attested preparation is in progress; run cancel-preparation first");
  if (attestation.manifestSha256 !== manifestSha256)
    refuse("backup_manifest_sha256 does not match the attested manifest");
  if (attestation.expiresAt <= now + ATTESTATION_MARGIN_SECONDS)
    refuse("The attestation expires within five minutes; attest again");
  return attestation;
}
function breakGlassRecord({ dispatch, attestation, outgoing, runToken, now }) {
  return {
    pk: "ENV",
    sk: `BREAK_GLASS#${runToken}`,
    recordType: "break_glass",
    schemaVersion: 1,
    runToken,
    runId: dispatch.runId,
    runAttempt: dispatch.runAttempt,
    commitSha: dispatch.commitSha,
    actor: dispatch.actor,
    triggeringActor: dispatch.triggeringActor,
    reason: dispatch.reason,
    manifestSha256: dispatch.manifestSha256,
    manifestUri: attestation.manifestUri,
    attestationKind: attestation.kind,
    attestationExpiresAt: attestation.expiresAt,
    sourceInstanceId: outgoing.instanceId,
    sourceTaskId: attestation.taskId,
    skippedChecks: [...SKIPPED_CHECKS],
    recordedAt: now,
  };
}
function withoutTime(record) {
  const copy = { ...record };
  delete copy.recordedAt;
  return copy;
}
/**
 * Break-glass admission for `prepare`. It runs after the handoff gate and
 * before Control is taken, so a refusal leaves production untouched, and the
 * audit record exists before any service mutation.
 */
function createBreakGlass(deps) {
  const { env, aws, tables, now, types, legacy, runtime, lookup } = deps;
  const enabled = breakGlassRequested(env);
  const key = (record) => marshall({ pk: record.pk, sk: record.sk });
  async function persist(record) {
    try {
      await aws("dynamodb", "put-item", {
        TableName: tables.deploymentControl,
        Item: marshall(record),
        ConditionExpression: "attribute_not_exists(pk)",
      });
    } catch (error) {
      const stored = await aws("dynamodb", "get-item", {
        TableName: tables.deploymentControl,
        Key: key(record),
        ConsistentRead: true,
      });
      if (
        !stored.Item ||
        !isDeepStrictEqual(
          withoutTime(unmarshall(stored.Item)),
          withoutTime(record),
        )
      )
        throw error;
    }
  }
  function publish(record) {
    if (env.BREAK_GLASS_RECORD_PATH)
      writeFileSync(
        env.BREAK_GLASS_RECORD_PATH,
        JSON.stringify(record, null, 2) + "\n",
      );
    console.log(
      `::warning title=Break-glass deployment::Recorded ${record.sk}; skipped ${record.skippedChecks.join(", ")}. Re-run the full deploy path within seven days.`,
    );
  }
  async function admit(outgoing) {
    if (!enabled) return undefined;
    if (deps.production)
      refuse("Break-glass is not available to the private production recipe");
    const dispatch = assertBreakGlassDispatch(env);
    const source = await runtime(outgoing);
    const attestation = verifyBreakGlassAttestation({
      row: await lookup(outgoing),
      source: { taskId: legacy.legacyTaskId(source) },
      manifestSha256: dispatch.manifestSha256,
      now: now(),
    });
    const record = breakGlassRecord({
      dispatch,
      attestation,
      outgoing,
      runToken: env.DEPLOYMENT_RUN_TOKEN,
      now: now(),
    });
    await persist(record);
    publish(record);
    return record;
  }
  /** A break-glass attestation stands in for a runtime seal only under break-glass. */
  function assertConsumable(row) {
    if (
      row.attestation?.kind === types.BREAK_GLASS_ATTESTATION_KIND &&
      !enabled
    )
      refuse(
        "A break-glass attestation is consumed only by a break-glass deployment",
      );
  }
  return { admit, assertConsumable };
}
module.exports = {
  SKIPPED_CHECKS,
  createBreakGlass,
  verifyBreakGlassAttestation,
};
