"use strict";
const assert = require("node:assert/strict");
const { assertPreservedHistory } = require("./sandbox-operation.cjs");
const { marshall } = require("@aws-sdk/util-dynamodb");
const {
  authorityFields,
  expectedFields,
  controlAuthority,
} = require("./carryforward-state.cjs");
const { candidateCheck } = require("./source-loss-state.cjs");
const { bindingHash } = require("./binding-hash.cjs");
function buildPreparingRecovery({
  observed,
  proof,
  proofSha256,
  executionRunToken,
  actorArn,
  now,
  types,
  builders,
}) {
  const previous = observed.control;
  assert.ok(previous.coordinatorExpiresAt <= now);
  assert.equal(previous.deployment.phase, "preparing");
  assert.equal(previous.deployment.taskDefinition, undefined);
  assert.equal(previous.deployment.candidate, undefined);
  assert.equal(previous.coordinatorToken, proof.logicalRunToken);
  const next = types.controlRecordSchema.parse({
    ...previous,
    coordinatorEpoch: previous.coordinatorEpoch + 1,
    coordinatorExpiresAt: now + 180,
    deployment: {
      ...previous.deployment,
      taskDefinition: proof.definitionArn,
      updatedAt: now,
    },
  });
  const receipt = {
    pk: observed.archive.pk,
    sk: "PREPARING_RECOVERY",
    recordType: "preparing_deployment_recovery",
    version: 1,
    operationId: proof.operationId,
    logicalRunToken: proof.logicalRunToken,
    executionRunToken,
    actorArn,
    toolSourceCommit: proof.sourceCommit,
    proofSha256,
    bindingSha256: observed.bindingSha256,
    archiveSha256: bindingHash(observed.archive),
    recoverySha256: bindingHash(observed.recovery),
    definitionArn: proof.definitionArn,
    definitionSha256: proof.definitionSha256,
    previousEpoch: previous.coordinatorEpoch,
    coordinatorEpoch: next.coordinatorEpoch,
    claimedAt: now,
  };
  const table = previous.deployment.tablePrefix + "DeploymentControlTable";
  const update = {
    TableName: table,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ...expectedFields(previous, authorityFields),
    UpdateExpression:
      "SET coordinatorEpoch = :nextEpoch, coordinatorExpiresAt = :nextExpiry, deployment = :nextDeployment",
  };
  Object.assign(
    update.ExpressionAttributeValues,
    marshall({
      ":nextEpoch": next.coordinatorEpoch,
      ":nextExpiry": next.coordinatorExpiresAt,
      ":nextDeployment": next.deployment,
    }),
  );
  const check = (row) => ({
    ConditionCheck: {
      TableName: table,
      Key: marshall({ pk: row.pk, sk: row.sk }),
      ...expectedFields(row, Object.keys(row)),
    },
  });
  const transaction = {
    TransactItems: [
      { Update: update },
      {
        Put: {
          TableName: table,
          Item: marshall(receipt),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      check(observed.archive),
      check(observed.recovery),
      candidateCheck({
        builders,
        table,
        ctl: previous,
        candidate: observed.source,
        admittedAt: observed.recovery.admittedAt,
        now,
      }),
    ],
  };
  return {
    next,
    receipt,
    archive: observed.archive,
    recovery: observed.recovery,
    transaction,
  };
}
async function commitPreparingRecovery({ aws, inspector, claim }) {
  try {
    await aws("dynamodb", "transact-write-items", claim.transaction);
  } catch (error) {
    try {
      assert.deepEqual(
        await inspector.read(claim.receipt.pk, claim.receipt.sk),
        claim.receipt,
      );
      assert.deepEqual(
        controlAuthority(await inspector.control()),
        controlAuthority(claim.next),
      );
      await assertPreservedHistory(inspector, claim);
    } catch (mismatch) {
      error.cause = mismatch;
      throw error;
    }
  }
}
module.exports = { buildPreparingRecovery, commitPreparingRecovery };
