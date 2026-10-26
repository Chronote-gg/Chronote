"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { bindingHash } = require("./continue-sandbox.cjs");
const { candidateCheck } = require("./source-loss-state.cjs");
const authorityFields = [
  "coordinatorToken",
  "coordinatorEpoch",
  "coordinatorExpiresAt",
  "servingGeneration",
  "servingMembers",
  "deployment",
  "compatibleReplacement",
];
function controlAuthority(control) {
  return Object.fromEntries(
    authorityFields
      .filter((key) => control[key] !== undefined)
      .map((key) => [key, control[key]]),
  );
}
function expectedFields(row, fields) {
  const names = {},
    values = {},
    conditions = [];
  for (const [index, field] of fields.entries()) {
    const name = "#f" + index,
      value = ":v" + index;
    names[name] = field;
    if (row[field] === undefined)
      conditions.push(`attribute_not_exists(${name})`);
    else {
      conditions.push(`${name} = ${value}`);
      values[value] = row[field];
    }
  }
  return {
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
  };
}
function archiveSchema(types) {
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  return z
    .object({
      pk: z.string().startsWith("CARRYFORWARD#"),
      sk: z.literal("ARCHIVE"),
      recordType: z.literal("historical_deployment_carryforward"),
      version: z.literal(1),
      operationId: z.string().uuid(),
      manifestSha256: hash,
      bindingSha256: hash,
      toolSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      imageSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      executionRunToken: z.string().regex(/^\d+-1$/),
      actorArn: z.string().min(1),
      policy: z.literal("normal_protected_deployments_with_unresolved_history"),
      operatorExclusion: z.literal("exclusive_approved_writer_window"),
      originalControl: types.controlRecordSchema,
      recoveryPk: z.string().startsWith("SOURCELOSS#"),
      recoverySha256: hash,
      settlement: z.literal("lost_owner_settlement_pending"),
      source: types.runtimeIdentitySchema,
      image: z.string().min(1),
      templateArn: z.string().min(1),
      preparedDefinitionSha256: hash,
      archivedAt: z.number().int().nonnegative(),
    })
    .strict();
}
function buildCarryforward({
  manifest,
  manifestSha256,
  bindingSha256,
  observed,
  runToken,
  actorArn,
  now,
  types,
  builders = require("../../dist/services/deploymentControlTransactions.js"),
}) {
  const previous = observed.control;
  const table = previous.deployment.tablePrefix + "DeploymentControlTable";
  const archive = archiveSchema(types).parse({
    pk: "CARRYFORWARD#" + manifest.operationId,
    sk: "ARCHIVE",
    recordType: "historical_deployment_carryforward",
    version: 1,
    operationId: manifest.operationId,
    manifestSha256,
    bindingSha256,
    toolSourceCommit: manifest.sourceCommit,
    imageSourceCommit: manifest.imageSourceCommit,
    executionRunToken: runToken,
    actorArn,
    policy: manifest.policy,
    operatorExclusion: manifest.operatorExclusion,
    originalControl: previous,
    recoveryPk: observed.recovery.pk,
    recoverySha256: bindingHash(observed.recovery),
    settlement: "lost_owner_settlement_pending",
    source: observed.source,
    image: manifest.image,
    templateArn: manifest.templateArn,
    preparedDefinitionSha256: manifest.preparedDefinitionSha256,
    archivedAt: now,
  });
  const next = types.controlRecordSchema.parse({
    ...previous,
    coordinatorToken: runToken,
    coordinatorEpoch: previous.coordinatorEpoch + 1,
    coordinatorExpiresAt: now + 180,
    deployment: {
      runToken,
      cluster: previous.deployment.cluster,
      service: previous.deployment.service,
      family: previous.deployment.family,
      tablePrefix: previous.deployment.tablePrefix,
      candidateId: manifest.operationId,
      image: manifest.image,
      runtimeMode: observed.runtimeMode,
      phase: "preparing",
      originalGeneration: previous.servingGeneration,
      originalMembers: Object.values(previous.servingMembers),
      outgoing: observed.source,
      previousTaskDefinition: previous.deployment.taskDefinition,
      routing: observed.routing,
      updatedAt: now,
    },
  });
  const transaction = {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          ...expectedFields(previous, authorityFields),
          UpdateExpression:
            "SET coordinatorToken = :nextToken, coordinatorEpoch = :nextEpoch, coordinatorExpiresAt = :nextExpiry, deployment = :nextDeployment",
        },
      },
      {
        Put: {
          TableName: table,
          Item: marshall(archive),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        ConditionCheck: {
          TableName: table,
          Key: marshall({ pk: observed.recovery.pk, sk: "RECOVERY" }),
          ...expectedFields(observed.recovery, Object.keys(observed.recovery)),
        },
      },
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
  Object.assign(
    transaction.TransactItems[0].Update.ExpressionAttributeValues,
    marshall({
      ":nextToken": next.coordinatorToken,
      ":nextEpoch": next.coordinatorEpoch,
      ":nextExpiry": next.coordinatorExpiresAt,
      ":nextDeployment": next.deployment,
    }),
  );
  return { next, archive, transaction };
}
async function commitCarryforward({ aws, inspector, claim }) {
  try {
    await aws("dynamodb", "transact-write-items", claim.transaction);
  } catch (error) {
    const saved = await inspector.read(inspector.archiveKey, "ARCHIVE");
    const current = await inspector.control();
    try {
      assert.deepEqual(saved, claim.archive);
      assert.deepEqual(controlAuthority(current), controlAuthority(claim.next));
    } catch {
      throw error;
    }
  }
}
module.exports = {
  authorityFields,
  expectedFields,
  archiveSchema,
  controlAuthority,
  buildCarryforward,
  commitCarryforward,
};
