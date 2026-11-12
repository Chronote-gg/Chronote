"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { bindingHash } = require("./binding-hash.cjs");
const { expectedFields } = require("./carryforward-state.cjs");
const { candidateCheck } = require("./source-loss-state.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const closeoutManifestSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    approveBefore: z.number().int().positive(),
    operatorExclusion: z.literal("exclusive_approved_writer_window"),
    providerEffects: z.literal("all_submitted_effects_settled"),
    controlSha256: hash,
    recoverySha256: hash,
    sourceRuntimeSha256: hash,
    historicalReplacement: z
      .object({
        origin: z.literal("unknown"),
        provenance: z.literal(
          "operator_retained_pre_operation_control_capture",
        ),
        captureSha256: hash,
        acknowledgementSha256: hash,
        successorControlSha256: hash,
        successorControl: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
    submissionFile: z.string().min(1).refine(path.isAbsolute),
  })
  .strict();
const publicationFields = [
  "publicationProtocol",
  "publicationCompatibleImages",
  "publicationPins",
  "publicationTransition",
];
function assertCloseoutOperation(service, operation, mode) {
  const reads = {
    dynamodb: ["get-item"],
    sts: ["get-caller-identity"],
    ecs: [
      "describe-tasks",
      "describe-services",
      "describe-task-definition",
      "get-task-protection",
      "list-tasks",
      "list-service-deployments",
      "describe-service-deployments",
      "describe-service-revisions",
    ],
    elbv2: [
      "describe-listeners",
      "describe-rules",
      "describe-target-groups",
      "describe-target-group-attributes",
      "describe-target-health",
    ],
  };
  assert(
    reads[service]?.includes(operation) ||
      (service === "dynamodb" &&
        operation === "transact-write-items" &&
        mode === "apply"),
    "Operation outside historical closeout",
  );
}
function controlCondition(control) {
  return expectedFields(control, [
    ...new Set([
      ...Object.keys(control),
      "maintenance",
      "compatibleReplacement",
      "recoveryScanCursor",
      ...publicationFields,
    ]),
  ]);
}
function condition(table, row, fields) {
  return {
    ConditionCheck: {
      TableName: table,
      Key: marshall({ pk: row.pk, sk: row.sk }),
      ...expectedFields(row, fields ?? Object.keys(row)),
    },
  };
}
function closeoutReceiptSchema(types) {
  return z
    .object({
      pk: z.string().startsWith("HISTORICALCLOSEOUT#"),
      sk: z.literal("RECEIPT"),
      recordType: z.literal("historical_handoff_closeout"),
      version: z.literal(1),
      operationId: z.string().uuid(),
      packetSha256: hash,
      bindingSha256: hash,
      executorCommit: z.string().regex(/^[a-f0-9]{40}$/),
      actorArn: z.string().min(1),
      closedAt: z.number().int().nonnegative(),
      result: z.literal("availability_handoff_closed_with_unsettled_history"),
      settlement: z.literal("lost_owner_settlement_pending"),
      originalControl: types.controlRecordSchema,
      sourceRuntime: types.runtimeRecordSchema,
      nativeProtection: z
        .object({
          taskArn: z.string().min(1),
          observedAt: z.number().int().nonnegative(),
          expiresAt: z.number().positive(),
        })
        .strict(),
      recovery: z
        .object({ pk: z.string(), sk: z.literal("RECOVERY"), sha256: hash })
        .strict(),
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict();
}
function closedControl(types, original, operationId, closedAt) {
  return types.controlRecordSchema.parse({
    ...original,
    coordinatorToken: "closeout#" + operationId,
    coordinatorExpiresAt: closedAt,
    deployment: {
      ...original.deployment,
      phase: "complete",
      updatedAt: closedAt,
    },
  });
}
function buildHistoricalCloseout({
  table,
  observed,
  packet,
  bindingSha256,
  types,
  builders,
  now,
}) {
  const {
    control: previous,
    sourceRuntime,
    recovery,
    candidate,
    artifact,
    sourceArtifact,
    introduction,
  } = observed;
  assert.equal(previous.deployment.phase, "promoted");
  assert(previous.coordinatorExpiresAt <= now);
  assert(packet.closeout.approveBefore > now);
  assert(
    observed.nativeProtection.observedAt <= now &&
      observed.nativeProtection.expiresAt > now + 120,
  );
  const next = closedControl(types, previous, packet.closeout.operationId, now);
  const receipt = closeoutReceiptSchema(types).parse({
    pk: "HISTORICALCLOSEOUT#" + packet.closeout.operationId,
    sk: "RECEIPT",
    recordType: "historical_handoff_closeout",
    version: 1,
    operationId: packet.closeout.operationId,
    packetSha256: bindingHash(packet),
    bindingSha256,
    executorCommit: packet.executorCommit,
    actorArn: packet.actorArn,
    closedAt: now,
    result: "availability_handoff_closed_with_unsettled_history",
    settlement: "lost_owner_settlement_pending",
    originalControl: previous,
    sourceRuntime,
    nativeProtection: observed.nativeProtection,
    recovery: {
      pk: recovery.pk,
      sk: recovery.sk,
      sha256: bindingHash(recovery),
    },
    evidence: observed.binding,
  });
  const update = {
    TableName: table,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ...controlCondition(previous),
    UpdateExpression:
      "SET coordinatorToken = :closedToken, coordinatorExpiresAt = :closedAt, deployment = :closedDeployment",
  };
  Object.assign(
    update.ExpressionAttributeValues,
    marshall({
      ":closedToken": next.coordinatorToken,
      ":closedAt": now,
      ":closedDeployment": next.deployment,
    }),
  );
  const selected = candidateCheck({
    builders,
    table,
    ctl: previous,
    candidate,
    admittedAt: recovery.admittedAt,
    now,
  });
  selected.ConditionCheck.ConditionExpression +=
    " AND #closeoutRole = :closeoutRole AND workCounts = :quiet AND attribute_not_exists(retirementContinuation)";
  selected.ConditionCheck.ExpressionAttributeNames = {
    ...selected.ConditionCheck.ExpressionAttributeNames,
    "#closeoutRole": "role",
  };
  Object.assign(
    selected.ConditionCheck.ExpressionAttributeValues,
    marshall({
      ":closeoutRole": "serving",
      ":quiet": observed.candidateRuntime.workCounts,
    }),
  );
  const active = condition(table, artifact, [
    "identity",
    "state",
    "startup",
    "request",
    "proof",
    "attestation",
    "retirementVerification",
  ]);
  active.ConditionCheck.ConditionExpression += " AND freshUntil > :artifactNow";
  Object.assign(
    active.ConditionCheck.ExpressionAttributeValues,
    marshall({ ":artifactNow": now + 5 }),
  );
  const hold = introduction
    ? condition(table, introduction)
    : {
        ConditionCheck: {
          TableName: table,
          Key: marshall({ pk: "ENV", sk: "INTRODUCTION" }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      };
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
      condition(table, recovery, [...Object.keys(recovery), "stoppedAt"]),
      {
        ConditionCheck: {
          TableName: table,
          Key: marshall({ pk: sourceRuntime.pk, sk: sourceRuntime.sk }),
          ...builders.snapshotCondition(sourceRuntime),
        },
      },
      selected,
      active,
      condition(table, sourceArtifact, [
        ...Object.keys(sourceArtifact),
        "retirementVerification",
      ]),
      hold,
    ],
  };
  return { next, receipt, transaction };
}
function recordSubmission(file, submission) {
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(submission));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
async function observeHistoricalCloseout({
  read,
  submission,
  packet,
  types,
  bindingSha256,
}) {
  submission = z
    .object({
      packetSha256: hash,
      transactionSha256: hash,
      transaction: z.record(z.string(), z.unknown()),
      next: types.controlRecordSchema,
      receipt: closeoutReceiptSchema(types),
    })
    .strict()
    .parse(submission);
  assert.equal(submission.packetSha256, bindingHash(packet));
  assert.equal(
    submission.transactionSha256,
    bindingHash(submission.transaction),
  );
  const expected = closeoutReceiptSchema(types).parse(submission.receipt);
  assert.equal(expected.packetSha256, bindingHash(packet));
  assert.equal(expected.operationId, packet.closeout.operationId);
  assert.equal(
    expected.pk,
    "HISTORICALCLOSEOUT#" + packet.closeout.operationId,
  );
  assert.equal(expected.actorArn, packet.actorArn);
  assert.equal(expected.executorCommit, packet.executorCommit);
  assert.equal(
    expected.nativeProtection.taskArn,
    packet.operation.candidateIdentity.taskArn,
  );
  assert(
    expected.nativeProtection.observedAt <= expected.closedAt &&
      expected.nativeProtection.expiresAt > expected.closedAt + 120,
  );
  assert.equal(expected.bindingSha256, bindingSha256);
  assert.equal(expected.bindingSha256, bindingHash(expected.evidence));
  assert.equal(
    bindingHash(expected.originalControl),
    packet.closeout.controlSha256,
  );
  assert.equal(
    bindingHash(expected.sourceRuntime),
    packet.closeout.sourceRuntimeSha256,
  );
  assert.deepEqual(expected.recovery, {
    pk: "SOURCELOSS#" + packet.operation.deployment.runToken,
    sk: "RECOVERY",
    sha256: packet.closeout.recoverySha256,
  });
  assert(
    expected.closedAt < packet.closeout.approveBefore &&
      expected.closedAt >= expected.originalControl.coordinatorExpiresAt,
  );
  const next = closedControl(
    types,
    expected.originalControl,
    packet.closeout.operationId,
    expected.closedAt,
  );
  assert.deepEqual(submission.next, next);
  assert.deepEqual(await read("ENV", "CONTROL"), next);
  assert.deepEqual(await read(expected.pk, expected.sk), expected);
  assert.equal(
    bindingHash(await read("ENV", expected.sourceRuntime.sk)),
    packet.closeout.sourceRuntimeSha256,
  );
  assert.equal(
    bindingHash(await read(expected.recovery.pk, expected.recovery.sk)),
    packet.closeout.recoverySha256,
  );
  return {
    kind: expected.result,
    settlement: expected.settlement,
    operationId: expected.operationId,
  };
}
module.exports = {
  closeoutManifestSchema,
  closeoutReceiptSchema,
  buildHistoricalCloseout,
  recordSubmission,
  observeHistoricalCloseout,
  publicationFields,
  assertCloseoutOperation,
};
