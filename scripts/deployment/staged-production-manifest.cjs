"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const {
  pausedDraftsSchema,
  validatePausedBinding,
} = require("./paused-draft-contract.cjs");
const {
  schema,
  envelopeSchema,
  assertHash,
  validateManifest,
  validateAuthorization,
  phases,
} = require("./introduction-validation.cjs");
const productionSchema = schema
  .extend({
    kind: z.literal("production-introduction"),
    environment: z.literal("production"),
    pausedDrafts: pausedDraftsSchema.optional(),
  })
  .strict();
const authorizationSchema = envelopeSchema
  .extend({ kind: z.literal("production-phase") })
  .strict();
function parseProductionManifest(input, expectedSha256) {
  assertHash(input, expectedSha256);
  const m = validateManifest(productionSchema.parse(input));
  const tables = [...Object.values(m.binding.tableArns), m.controlTableArn];
  const roles = [
    m.deploymentRoleArn,
    m.executionRoleArn,
    m.binding.taskRoleArn,
  ];
  const definitions = [
    m.taskDefinition,
    m.legacyTaskDefinition,
    m.fallbackTaskDefinition,
  ];
  const groups = [m.targetGroupA, m.targetGroupB];
  const names = [
    m.cluster,
    m.service,
    m.bucket,
    m.tablePrefix,
    m.containerName,
    m.imageRepository,
  ];
  for (const value of [
    ...names,
    ...tables,
    ...definitions,
    ...roles,
    m.listenerArn,
    ...groups,
  ])
    assert.ok(!/sandbox|rehearsal/i.test(value), "Nonproduction resource");
  const resourceNames = [
    ...names,
    ...roles.map((arn) => arn.split("/").at(-1)),
    ...tables.map((arn) => arn.split("/")[1]),
    ...definitions.map((arn) => arn.split("/")[1].split(":")[0]),
    m.listenerArn.split("/")[2],
    ...groups.map((arn) => arn.split("/")[1]),
  ];
  for (const name of resourceNames)
    assert.ok(!/^cr-[a-f0-9]{16}-/.test(name), "Nonproduction resource");
  validatePausedBinding(m);
  return m;
}
function parsePhaseAuthorization(input, manifest, expectedSha256) {
  const m = parseProductionManifest(manifest, expectedSha256);
  const a = validateAuthorization(
    input,
    authorizationSchema.parse(input.envelope),
    m,
    expectedSha256,
  );
  const roleName = m.deploymentRoleArn.split("/").at(-1);
  assert.equal(
    a.principalArn,
    `arn:aws:sts::${m.binding.accountId}:assumed-role/${roleName}/chronote-production-${a.runId}-1`,
  );
  return a;
}
module.exports = { parseProductionManifest, parsePhaseAuthorization, phases };
