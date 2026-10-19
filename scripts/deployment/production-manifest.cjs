"use strict";
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { z } = require("zod");
const id = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = (schema) =>
  z
    .array(schema)
    .min(1)
    .max(100)
    .refine((v) => new Set(v.map((x) => JSON.stringify(x))).size === v.length);
const seconds = z.number().int().nonnegative();
const identitySchema = z
  .object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    repository: id,
    githubEnvironment: z.literal("production"),
    ref: id,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    workflow: id,
    runId: id,
    runAttempt: id,
    roleArn: id,
    sessionName: id,
  })
  .strict();
const actionBase = { actionId: id, predecessor: id.nullable() };
const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...actionBase, kind: z.literal("stop_legacy"), taskArn: id })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("route_maintenance"),
      targetGroup: z.enum(["a", "b"]),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("route_candidate"),
      targetGroup: z.enum(["a", "b"]),
      launchActionId: id,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("launch_candidate"),
      slot: z.enum(["bootstrap", "handoff"]),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("hold_launcher"),
      launcherId: id,
      priorStateHash: hash,
      heldStateHash: hash,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("restore_launcher"),
      launcherId: id,
      holdActionId: id,
    })
    .strict(),
]);
const grantSchema = z
  .object({
    grantId: id,
    commandId: id,
    meetingId: id,
    guildId: id,
    voiceChannelId: id,
    textChannelId: id,
    actorUserId: id,
    sessionMode: z.literal("meeting"),
  })
  .strict();
const executionSchema = z
  .object({
    kind: z.literal("execution"),
    schemaVersion: z.literal(1),
    environment: z.literal("production"),
    introductionId: id,
    holdId: id,
    operationId: id,
    validFrom: seconds,
    validUntil: seconds,
    identity: identitySchema,
    runtime: z
      .object({
        clusterArn: id,
        serviceArn: id,
        family: id,
        container: id,
        mode: z.enum(["all", "bot", "api"]),
        cpu: z.literal(512),
        memory: z.literal(1024),
        legacyDefinition: id,
        legacyTaskArns: unique(id),
        candidateId: id,
        candidateDefinition: id,
        candidateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        continuationDefinition: id,
        continuationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        configurationHash: hash,
      })
      .strict(),
    resources: z
      .object({
        tables: z
          .object(
            Object.fromEntries(
              [
                "deploymentControl",
                "activeMeeting",
                "meetingHistory",
                "meetingControl",
                "personalJob",
                "personalSegment",
                "notion",
                "stripeWebhook",
                "guildSubscription",
              ].map((key) => [key, id]),
            ),
          )
          .strict(),
        bucket: id,
        artifactPrefixes: unique(id),
        listenerArn: id,
        targetGroupA: id,
        targetGroupB: id,
        taskRoleArn: id,
        executionRoleArn: id,
        configurationReferenceHash: hash,
      })
      .strict(),
    handoff: z
      .object({
        runToken: id,
        priorRunToken: id,
        priorEpoch: z.number().int().positive(),
        priorGeneration: z.literal(1),
        priorCandidateId: id,
        candidateId: id,
        grants: z.array(grantSchema).length(2),
      })
      .strict(),
    prerequisites: z
      .object(
        Object.fromEntries(
          [
            "sourceTests",
            "plan",
            "launcherHolds",
            "retainedDisposition",
            "fixtureChecklist",
            "executionApproval",
          ].map((key) => [key, hash]),
        ),
      )
      .strict(),
    launcherRoutes: unique(
      z
        .object({
          kind: z.enum(["workflow", "manual"]),
          id,
          evidenceHash: hash,
        })
        .strict(),
    ),
    actions: unique(actionSchema),
  })
  .strict();
const setPaths = new Set([
  "runtime.legacyTaskArns",
  "resources.artifactPrefixes",
  "launcherRoutes",
  "handoff.grants",
]);
function canonical(value, path = "") {
  if (Array.isArray(value)) {
    const entries = value.map((v) => canonical(v, path));
    return setPaths.has(path)
      ? entries.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )
      : entries;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical(value[key], path ? `${path}.${key}` : key),
        ]),
    );
  return value;
}
function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function refuse() {
  throw new Error("introduction_refused");
}
function assertRuntimeResources(m) {
  const { accountId, region } = m.identity,
    r = m.runtime,
    ecs = `arn:aws:ecs:${region}:${accountId}:`;
  const cluster = r.clusterArn.slice((ecs + "cluster/").length);
  if (
    !r.clusterArn.startsWith(ecs + "cluster/") ||
    !r.serviceArn.startsWith(ecs + `service/${cluster}/`) ||
    ![
      r.legacyDefinition,
      r.candidateDefinition,
      r.continuationDefinition,
    ].every(
      (v) =>
        v.startsWith(ecs + `task-definition/${r.family}:`) && /:\d+$/.test(v),
    ) ||
    !r.legacyTaskArns.every((v) => v.startsWith(ecs + `task/${cluster}/`))
  )
    refuse();
}
function assertResources(m) {
  assertRuntimeResources(m);
  const { accountId, region } = m.identity,
    s = m.resources,
    elb = `arn:aws:elasticloadbalancing:${region}:${accountId}:`;
  if (
    !s.listenerArn.startsWith(elb + "listener/app/") ||
    ![s.targetGroupA, s.targetGroupB].every((v) =>
      v.startsWith(elb + "targetgroup/"),
    ) ||
    s.targetGroupA === s.targetGroupB ||
    ![m.identity.roleArn, s.taskRoleArn, s.executionRoleArn].every((v) =>
      v.startsWith(`arn:aws:iam::${accountId}:role/`),
    )
  )
    refuse();
  assertHandoff(m);
}
function assertHandoff(m) {
  if (
    m.handoff.runToken === m.handoff.priorRunToken ||
    m.handoff.priorCandidateId !== m.runtime.candidateId ||
    m.handoff.candidateId === m.runtime.candidateId ||
    m.validUntil <= m.validFrom ||
    !m.identity.workflow.startsWith(
      m.identity.repository + "/.github/workflows/",
    ) ||
    !m.identity.workflow.endsWith("@" + m.identity.ref)
  )
    refuse();
  for (const field of ["grantId", "commandId", "meetingId"])
    if (new Set(m.handoff.grants.map((g) => g[field])).size !== 2) refuse();
  if (
    !["workflow", "manual"].every((kind) =>
      m.launcherRoutes.some((route) => route.kind === kind),
    )
  )
    refuse();
}
function assertActions(m) {
  const seen = new Map();
  for (const a of m.actions) {
    if (
      seen.has(a.actionId) ||
      (a.predecessor !== null && !seen.has(a.predecessor))
    )
      refuse();
    if (
      a.kind === "stop_legacy" &&
      !m.runtime.legacyTaskArns.includes(a.taskArn)
    )
      refuse();
    if (
      a.kind === "route_candidate" &&
      seen.get(a.launchActionId)?.kind !== "launch_candidate"
    )
      refuse();
    if (
      a.kind === "restore_launcher" &&
      (seen.get(a.holdActionId)?.kind !== "hold_launcher" ||
        seen.get(a.holdActionId).launcherId !== a.launcherId)
    )
      refuse();
    seen.set(a.actionId, a);
  }
}
function parsePreparation(input) {
  return z
    .object({
      kind: z.literal("preparation"),
      schemaVersion: z.literal(1),
      environment: z.literal("production"),
      deferred: unique(
        z.enum([
          "identity",
          "runtime",
          "resources",
          "handoff",
          "actions",
          "prerequisites",
          "launcherRoutes",
          "validity",
        ]),
      ),
    })
    .strict()
    .parse(input);
}
function parseExecution(input, expectedHash) {
  if (
    !hash.safeParse(expectedHash).success ||
    canonicalHash(input) !== expectedHash
  )
    refuse();
  const m = executionSchema.parse(input);
  assertResources(m);
  assertActions(m);
  return m;
}
function bindExecution(input, jobIdentity, callerIdentity) {
  const m = parseExecution(input, canonicalHash(input));
  const job = identitySchema
    .extend({ now: seconds, endpointOverrides: z.array(id).length(0) })
    .strict()
    .parse(jobIdentity);
  const now = job.now;
  const identity = identitySchema.parse(
    Object.fromEntries(
      Object.entries(job).filter(
        ([key]) => !["now", "endpointOverrides"].includes(key),
      ),
    ),
  );
  const caller = z
    .object({ accountId: id, arn: id })
    .strict()
    .parse(callerIdentity);
  const role = m.identity.roleArn.split(":role/")[1];
  if (
    !isDeepStrictEqual(identity, m.identity) ||
    now < m.validFrom ||
    now >= m.validUntil ||
    caller.accountId !== m.identity.accountId ||
    caller.arn !==
      `arn:aws:sts::${caller.accountId}:assumed-role/${role}/${m.identity.sessionName}`
  )
    refuse();
  return { manifest: m, manifestHash: canonicalHash(m), actor: caller.arn };
}
function assertBoundExecution(binding, now) {
  const m = parseExecution(binding.manifest, binding.manifestHash);
  seconds.parse(now);
  const expected = `arn:aws:sts::${m.identity.accountId}:assumed-role/${m.identity.roleArn.split(":role/")[1]}/${m.identity.sessionName}`;
  if (binding.actor !== expected || now < m.validFrom || now >= m.validUntil)
    refuse();
  return m;
}
function publicFailure() {
  return { status: "refused", reason: "introduction_refused" };
}
module.exports = {
  parsePreparation,
  parseExecution,
  bindExecution,
  canonicalHash,
  publicFailure,
  actionSchema,
  assertBoundExecution,
};
