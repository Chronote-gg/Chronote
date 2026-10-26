"use strict";
const assert = require("node:assert/strict");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { z } = require("zod");
function receiptSchema(types) {
  const base = z
    .object({
      pk: z.string().startsWith("SOURCELOSS#"),
      sk: z.literal("RECOVERY"),
      recordType: z.literal("source_loss_recovery"),
      version: z.literal(1),
      bindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
      runToken: z.string().min(1),
      actorArn: z.string().min(1),
      source: types.runtimeIdentitySchema,
      candidate: types.runtimeIdentitySchema,
      stoppedAt: z.string().datetime({ offset: true }),
      admittedAt: z.number().int().nonnegative(),
      stage: z.enum([
        "admission_transferred",
        "forward_submitted",
        "availability_restored",
      ]),
      settlement: z.literal("lost_owner_settlement_pending"),
      settlementReason: z.literal("incomplete_durable_effect_ledger"),
      metadataAudit: z
        .object({
          collectedAt: z.number().int().nonnegative(),
          records: z.record(
            z.string(),
            z.array(z.record(z.string(), z.unknown())),
          ),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          counts: z.record(z.string(), z.number().int().nonnegative()),
        })
        .strict(),
      updatedAt: z.number().int().nonnegative(),
    })
    .strict();
  return z.discriminatedUnion("version", [
    base,
    base.extend({
      version: z.literal(2),
      terminalProof: z
        .object({
          kind: z.literal("operator_retained_ecs_stop"),
          packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
          originalSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
          capturedAt: z.string().datetime({ offset: true }),
          provenance: z.literal("operator_captured_provider_response"),
          nativeObservation: z.enum(["MISSING", "STOPPED"]),
        })
        .strict(),
    }),
  ]);
}
function initialReceipt({
  d,
  candidate,
  terminal,
  admittedAt,
  actorArn,
  bindingSha256,
  metadataAudit,
}) {
  const evidence = terminal.terminalProof
    ? { version: 2, terminalProof: terminal.terminalProof }
    : { version: 1 };
  return {
    pk: "SOURCELOSS#" + d.runToken,
    sk: "RECOVERY",
    recordType: "source_loss_recovery",
    ...evidence,
    bindingSha256,
    runToken: d.runToken,
    actorArn,
    source: d.outgoing,
    candidate,
    stoppedAt: terminal.stoppedAt,
    admittedAt,
    stage: "admission_transferred",
    settlement: "lost_owner_settlement_pending",
    settlementReason: "incomplete_durable_effect_ledger",
    metadataAudit,
    updatedAt: admittedAt,
  };
}
function controlUpdate(table, previous, next) {
  return {
    Update: {
      TableName: table,
      Key: marshall({ pk: "ENV", sk: "CONTROL" }),
      ConditionExpression:
        "coordinatorToken = :token AND coordinatorEpoch = :epoch AND coordinatorExpiresAt = :expiry AND servingGeneration = :generation AND servingMembers = :members AND deployment = :deployment",
      UpdateExpression:
        "SET coordinatorExpiresAt = :nextExpiry, deployment = :nextDeployment",
      ExpressionAttributeValues: marshall({
        ":token": previous.coordinatorToken,
        ":epoch": previous.coordinatorEpoch,
        ":expiry": previous.coordinatorExpiresAt,
        ":generation": previous.servingGeneration,
        ":members": previous.servingMembers,
        ":deployment": previous.deployment,
        ":nextExpiry": next.coordinatorExpiresAt,
        ":nextDeployment": next.deployment,
      }),
    },
  };
}
function receiptWrite(table, previous, next) {
  return {
    Put: {
      TableName: table,
      Item: marshall(next),
      ConditionExpression: previous
        ? "bindingSha256 = :binding AND stage = :stage AND updatedAt = :updated AND settlement = :settlement"
        : "attribute_not_exists(pk)",
      ...(previous
        ? {
            ExpressionAttributeValues: marshall({
              ":binding": previous.bindingSha256,
              ":stage": previous.stage,
              ":updated": previous.updatedAt,
              ":settlement": previous.settlement,
            }),
          }
        : {}),
    },
  };
}
function promotion({ builders, table, ctl, next, candidate, receipt, now }) {
  const transaction = builders.buildPromotionTransaction({
    tables: { deploymentControl: table },
    coordinatorToken: ctl.coordinatorToken,
    coordinatorEpoch: ctl.coordinatorEpoch,
    expectedServingGeneration: ctl.servingGeneration,
    expectedServingMembers: Object.values(ctl.servingMembers),
    candidate,
    candidateRuntimeMode: ctl.deployment.runtimeMode,
    proposedGeneration: next.servingGeneration,
    now,
  });
  const update = transaction.TransactItems[0].Update;
  // Exact expired ownership is renewed atomically with admission, never by a preparatory write.
  update.ConditionExpression =
    update.ConditionExpression.replace(
      "coordinatorExpiresAt > :now",
      "coordinatorExpiresAt = :expiry",
    ) + " AND deployment = :deployment";
  update.UpdateExpression +=
    ", coordinatorExpiresAt = :expiryNext, deployment = :deploymentNext";
  Object.assign(
    update.ExpressionAttributeValues,
    marshall({
      ":expiry": ctl.coordinatorExpiresAt,
      ":deployment": ctl.deployment,
      ":expiryNext": next.coordinatorExpiresAt,
      ":deploymentNext": next.deployment,
    }),
  );
  // The Control condition no longer uses :now; unused expression values are invalid in DynamoDB.
  delete update.ExpressionAttributeValues[":now"];
  const runtimeUpdate = transaction.TransactItems[1].Update;
  runtimeUpdate.ConditionExpression +=
    " AND authorizedGeneration = :generation AND protection.expiresAt > :margin";
  Object.assign(
    runtimeUpdate.ExpressionAttributeValues,
    marshall({ ":margin": now + 120 }),
  );
  transaction.TransactItems.push(receiptWrite(table, undefined, receipt));
  return transaction;
}
function candidateCheck({ builders, table, ctl, candidate, admittedAt, now }) {
  const check = builders.buildRuntimeAdmissionChecks(
    {
      instanceId: candidate.instanceId,
      identity: candidate,
      authorizedGeneration: ctl.servingGeneration,
      observedEpoch: ctl.coordinatorEpoch,
      protocolVersion: 1,
      now,
    },
    { deploymentControl: table },
  )[1];
  check.ConditionCheck.ConditionExpression +=
    " AND readiness.observedEpoch = :epoch AND readiness.runtimeMode = :mode AND heartbeatAt > :admitted AND readiness.provenAt > :admitted AND protection.expiresAt > :margin AND attribute_not_exists(retirementRequest) AND attribute_not_exists(retirementAcknowledgment)";
  Object.assign(
    check.ConditionCheck.ExpressionAttributeValues,
    marshall({
      ":epoch": ctl.coordinatorEpoch,
      ":mode": ctl.deployment.runtimeMode,
      ":admitted": admittedAt,
      ":margin": now + 120,
    }),
  );
  return check;
}
async function writeState({
  aws,
  inspector,
  types,
  transaction,
  next,
  receipt,
}) {
  types.controlRecordSchema.parse(next);
  receiptSchema(types).parse(receipt);
  try {
    await aws("dynamodb", "transact-write-items", transaction);
  } catch (error) {
    const observed = await inspector.control();
    const saved = await inspector.read(receipt.pk, receipt.sk);
    // Acknowledgment loss is settled only by exact atomic state, never by retrying a write.
    try {
      assert.deepEqual(saved, receipt);
      for (const key of [
        "coordinatorToken",
        "coordinatorEpoch",
        "coordinatorExpiresAt",
        "servingGeneration",
        "servingMembers",
        "deployment",
      ])
        assert.deepEqual(observed[key], next[key]);
    } catch {
      throw error;
    }
  }
  return next;
}
module.exports = {
  receiptSchema,
  initialReceipt,
  controlUpdate,
  receiptWrite,
  promotion,
  candidateCheck,
  writeState,
};
