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
} = require("./introduction-validation.cjs");
const rehearsalSchema = schema
  .extend({
    kind: z.literal("rehearsal-introduction"),
    environment: z.literal("rehearsal"),
    pausedDrafts: pausedDraftsSchema.optional(),
    disposablePrefix: z.string(),
    resourceEvidence: z.array(
      z
        .object({
          arn: z.string().min(1),
          tags: z
            .object({
              Environment: z.literal("rehearsal"),
              OperationId: z.string().uuid(),
              DisposablePrefix: z.string(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();
const authorizationSchema = envelopeSchema
  .extend({ kind: z.literal("rehearsal-phase") })
  .strict();
function assertOwnedResources(m) {
  const { accountId, region, operationId, tableArns, taskRoleArn } = m.binding;
  const prefix = `cr-${operationId.replaceAll("-", "").slice(0, 16)}-`;
  assert.equal(m.disposablePrefix, prefix);
  assert.equal(m.tablePrefix, prefix);
  const name = (value, limit) => {
    assert.ok(
      value.startsWith(prefix) &&
        value.length > prefix.length &&
        value.length <= limit,
      "Resource outside disposable namespace",
    );
    assert.match(value, /^[a-zA-Z0-9_-]+$/);
    assert.ok(
      !/production|sandbox/i.test(value),
      "Active environment resource",
    );
  };
  for (const value of [
    m.cluster,
    m.service,
    m.containerName,
    m.imageRepository,
  ])
    name(value, 255);
  assert.match(m.imageRepository, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
  name(m.bucket, 63);
  assert.match(m.bucket, new RegExp(`^${prefix}[a-z0-9]+$`));
  const roles = [taskRoleArn, m.executionRoleArn, m.deploymentRoleArn];
  assert.equal(new Set(roles).size, 3, "Roles must be distinct");
  for (const role of roles) name(role.split(":role/")[1], 64);
  const definitions = [
    m.legacyTaskDefinition,
    m.taskDefinition,
    m.fallbackTaskDefinition,
  ];
  for (const definition of definitions)
    name(definition.split("task-definition/")[1].split(":")[0], 255);
  for (const arn of [...Object.values(tableArns), m.controlTableArn])
    name(arn.split("table/")[1], 255);
  const elb = `arn:aws:elasticloadbalancing:${region}:${accountId}:`;
  assert.ok(m.listenerArn.startsWith(elb + "listener/app/"));
  const listener = m.listenerArn
    .slice((elb + "listener/app/").length)
    .split("/");
  assert.equal(listener.length, 3);
  name(listener[0], 32);
  assert.match(listener[0], /^[a-zA-Z0-9-]*[a-zA-Z0-9]$/);
  for (const id of listener.slice(1)) assert.match(id, /^[a-f0-9]{16}$/);
  for (const arn of [m.targetGroupA, m.targetGroupB]) {
    const group = arn.slice((elb + "targetgroup/").length).split("/");
    assert.equal(group.length, 2);
    name(group[0], 32);
    assert.match(group[0], /^[a-zA-Z0-9-]*[a-zA-Z0-9]$/);
    assert.match(group[1], /^[a-f0-9]{16}$/);
  }
  const ecs = `arn:aws:ecs:${region}:${accountId}:`;
  assert.equal(
    m.legacyTaskArn,
    ecs + "task/" + m.cluster + "/" + m.legacyTaskArn.split("/").at(-1),
    "Invalid task ARN path",
  );
  const expected = [
    ...new Set([
      ...roles,
      ...definitions,
      ...Object.values(tableArns),
      m.controlTableArn,
      m.legacyTaskArn,
      ecs + "cluster/" + m.cluster,
      ecs + "service/" + m.cluster + "/" + m.service,
      m.listenerArn,
      m.targetGroupA,
      m.targetGroupB,
      `arn:aws:s3:::${m.bucket}`,
      `arn:aws:ecr:${region}:${accountId}:repository/${m.imageRepository}`,
    ]),
  ].sort();
  assert.deepEqual(
    m.resourceEvidence.map((entry) => entry.arn).sort(),
    expected,
    "Missing, duplicate or foreign resource evidence",
  );
  for (const entry of m.resourceEvidence)
    assert.deepEqual(entry.tags, {
      Environment: "rehearsal",
      OperationId: operationId,
      DisposablePrefix: prefix,
    });
}
function parseRehearsalManifest(input, expectedSha256) {
  assertHash(input, expectedSha256);
  const m = validateManifest(rehearsalSchema.parse(input));
  assertOwnedResources(m);
  // Declared tags are expectations. Only the future trusted collector can prove native ownership.
  validatePausedBinding(m);
  return m;
}
function parseRehearsalAuthorization(input, manifest, expectedSha256) {
  const m = parseRehearsalManifest(manifest, expectedSha256);
  const envelope = authorizationSchema.parse(input.envelope);
  const roleName = m.deploymentRoleArn.split("/").at(-1);
  assert.equal(
    envelope.principalArn,
    `arn:aws:sts::${m.binding.accountId}:assumed-role/${roleName}/chronote-rehearsal-${envelope.runId}-1`,
  );
  return validateAuthorization(input, envelope, m, expectedSha256);
}
module.exports = { parseRehearsalManifest, parseRehearsalAuthorization };
