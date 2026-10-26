#!/usr/bin/env node
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { z } = require("zod");

const identity = z.string().min(1).max(300);
const sandboxResource = identity.refine(
  (value) => /sandbox/i.test(value),
  "An explicit Sandbox resource is required",
);
const artifact = z
  .object({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    taskDefinition: identity,
  })
  .strict();
const configSchema = z
  .object({
    environment: z.literal("sandbox"),
    accountId: z.string().regex(/^\d{12}$/),
    region: identity,
    cluster: sandboxResource,
    service: sandboxResource,
    tablePrefix: sandboxResource,
    bucket: sandboxResource,
    fixture: z
      .object({
        runId: z.string().uuid(),
        guildId: identity,
        voiceChannelId: identity,
        textChannelId: identity,
        ownerUserId: identity,
        prefix: z.string().regex(/^generated\/handoff\/[a-f0-9-]{36}\/$/),
        checksums: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
      })
      .strict(),
    old: artifact,
    candidate: artifact,
    rollback: artifact,
  })
  .strict();

function buildSandboxHandoffPlan(input) {
  const config = configSchema.parse(input);
  if (config.fixture.prefix !== `generated/handoff/${config.fixture.runId}/`)
    throw new Error("Fixture prefix must bind the exact run identity");
  return {
    schemaVersion: 1,
    mode: "dry-run",
    environment: "sandbox",
    providerMutations: 0,
    identityVerification: "UNKNOWN",
    providerAcceptance: "UNKNOWN",
    cleanupRoute: "MISSING",
    inputSha256: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex"),
    fixtureChecksums: config.fixture.checksums,
    stages: [
      "Refresh exact Sandbox resource, bot and old/candidate/rollback artifact identities",
      "Prove the separately approved legacy introduction bridge before activation",
      "Protect old work; admit starts while candidate warms; refuse a failed candidate",
      "Promote a ready candidate; admit an unrelated guild; control and finalize old work",
      "Prove all seven actual work producers prevent early retirement",
      "Before retirement requests, roll back admission while candidate retains owned work",
      "Exercise compatible replacement and recovery without clearing the original voice guard",
      "Verify original settings, capture coverage, delivery and ancillary no-replay outcomes",
      "Measure representative 30/60/100-second preservation targets and native protection",
      "Revalidate ownership and use a separately authorized completed-object deletion procedure",
    ].map((operation, index) => ({
      stage: index + 1,
      operation,
      outcome: "NOT_RUN",
    })),
    localChecks: [
      "test/deployment/warmHandoff.integration.test.ts",
      "test/deployment/recordingRecoveryFaults.integration.test.ts",
      "test/deployment/sandboxHandoffRunner.test.ts",
    ],
  };
}

// A static, generated-fixture review aid. It is never a live deletion fence.
const owner = z
  .object({
    meetingId: identity,
    ownerInstanceId: identity,
    executionVersion: z.number().int().positive(),
  })
  .strict();
const proof = z
  .object({ owner, outcome: z.literal("verified_settled"), receipt: identity })
  .strict();
const pathIdentity = identity.regex(/^[A-Za-z0-9-]+$/);
const cleanupSchema = z
  .object({
    scope: z.literal("generated-local"),
    prefix: z.string().regex(/^generated\/handoff\/[a-f0-9-]{36}\/$/),
    fixture: z
      .object({
        guildId: pathIdentity,
        channelId: pathIdentity,
        meetingId: pathIdentity,
        reservedAt: z.string().datetime(),
      })
      .strict(),
    history: z
      .object({
        owner,
        status: z.enum(["complete", "cancelled", "interrupted", "failed"]),
        checkpoint: z.object({ artifactFolder: identity }).strict(),
        receipt: identity,
      })
      .strict(),
    capture: proof,
    recovery: proof,
    currentWork: proof,
    enumeration: z
      .object({
        complete: z.literal(true),
        keys: z.array(identity),
        receipt: identity,
      })
      .strict(),
  })
  .strict();
function planGeneratedDescendantRemoval(input) {
  const parsed = cleanupSchema.parse(input);
  // Match getRecordingArtifactFolder; the integration case uses its real checkpoint output.
  const { guildId, channelId, meetingId, reservedAt } = parsed.fixture;
  const timestamp = new Date(reservedAt).toISOString().replace(/:/g, "-");
  const artifactFolder = `${parsed.prefix}${guildId}/${channelId}_${meetingId}_${timestamp}/`;
  if (
    parsed.history.owner.meetingId !== meetingId ||
    parsed.history.checkpoint.artifactFolder !== artifactFolder
  )
    throw new Error(
      "Terminal checkpoint folder must match the exact reviewed meeting fixture",
    );
  const expected = JSON.stringify(parsed.history.owner);
  for (const item of [parsed.capture, parsed.recovery, parsed.currentWork])
    if (JSON.stringify(item.owner) !== expected)
      throw new Error("Ownership proof does not match terminal history");
  const keys = [...new Set(parsed.enumeration.keys)];
  if (
    keys.some(
      (key) =>
        !key.startsWith(artifactFolder) ||
        key === artifactFolder ||
        key.split("/").some((part) => part === "." || part === "..") ||
        key.includes("\\"),
    )
  )
    throw new Error(
      "Every descendant must stay inside the exact generated fixture folder",
    );
  return {
    scope: "generated-local",
    keys,
    liveDeletionAuthorized: false,
    liveOwnershipFence: false,
  };
}
function runCli(args) {
  if (args.length !== 3 || args[0] !== "--dry-run" || args[1] !== "--config")
    throw new Error(
      "Usage: verify-sandbox-handoff.cjs --dry-run --config <explicit-sandbox-fixture.json>; execution is not implemented",
    );
  return buildSandboxHandoffPlan(JSON.parse(fs.readFileSync(args[2], "utf8")));
}
if (require.main === module) {
  try {
    process.stdout.write(
      `${JSON.stringify(runCli(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch {
    process.stderr.write(
      "Sandbox dry-run refused: supply the exact documented Sandbox fixture config. No operations ran.\n",
    );
    process.exitCode = 1;
  }
}
module.exports = {
  buildSandboxHandoffPlan,
  planGeneratedDescendantRemoval,
  runCli,
};
