"use strict";
const { z } = require("zod");
const { createHash } = require("node:crypto");
const { githubJson } = require("./production-private-package.cjs");
const {
  frozenFixtureDefinitions,
} = require("./production-fixture-definitions.cjs");
const id = z.string().min(1).max(1024),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const object = z
  .object({
    key: id,
    versionId: id.refine((v) => v !== "null"),
    checksumSha256: hash,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  })
  .strict();
const review = z
  .object({
    grantId: id,
    commandId: id,
    meetingId: id,
    ownerInstanceId: id,
    executionVersion: z.literal(1),
    voiceOperationAttemptId: id,
    historyKey: z.object({ guildId: id, channelId_timestamp: id }).strict(),
    transcript: object,
    manifest: object,
    notes: z
      .object({
        version: z.literal(1),
        checksumSha256: hash,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(256 * 1024),
        channelId: id,
        messageIds: z.array(id).min(1).max(100),
      })
      .strict(),
    scriptSha256: hash,
    checklistSha256: hash,
    scriptFidelity: z.literal("pass"),
    ambientInputAbsent: z.literal("pass"),
    items: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            transcript: z.literal("pass"),
            notes: z.literal("pass"),
          })
          .strict(),
      )
      .min(6)
      .max(10),
  })
  .strict();
const supplementSchema = z
  .object({
    schemaVersion: z.literal(1),
    introductionId: id,
    holdId: id,
    holdRevision: z.literal(1),
    manifestHash: hash,
    runId: id,
    runAttempt: z.literal("1"),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    reviewedAt: z.string().datetime(),
    reviewerId: z.string().regex(/^\d+$/),
    fixtures: z.tuple([review, review]),
  })
  .strict();
function refuse() {
  throw Error("acceptance_supplement_refused");
}
function verifySupplement(input, binding, approvedReviewerIds, now) {
  const value = supplementSchema.parse(input),
    m = binding.manifest;
  if (
    value.introductionId !== m.introductionId ||
    value.holdId !== m.holdId ||
    value.manifestHash !== binding.manifestHash ||
    value.runId !== m.identity.runId ||
    value.sourceCommit !== m.identity.sourceCommit ||
    value.runAttempt !== m.identity.runAttempt ||
    !m.acceptance.manualReviewerIds.includes(value.reviewerId) ||
    (approvedReviewerIds !== undefined &&
      !approvedReviewerIds.includes(value.reviewerId)) ||
    Date.parse(value.reviewedAt) < m.validFrom * 1000 ||
    Date.parse(value.reviewedAt) > now * 1000 ||
    now >= m.validUntil
  )
    refuse();
  verifyFixtureReviews(value, m);
  return value;
}
function verifyFixtureReviews(value, m) {
  for (const [index, item] of value.fixtures.entries()) {
    const grant = m.handoff.grants[index],
      definition = frozenFixtureDefinitions().fixtures[index];
    if (
      [
        "grantId",
        "commandId",
        "meetingId",
        "scriptSha256",
        "checklistSha256",
      ].some((key) => item[key] !== grant[key]) ||
      item.historyKey.guildId !== grant.guildId ||
      item.notes.channelId !== grant.textChannelId ||
      new Set(item.notes.messageIds).size !== item.notes.messageIds.length ||
      item.items.length !== definition.checklist.length ||
      item.items.some((entry, n) => entry.index !== n)
    )
      refuse();
  }
}
async function readPinnedSupplement(binding, env, mode) {
  const m = binding.manifest,
    declaration = m.acceptance;
  if (!declaration || !["prepare-acceptance", "accept"].includes(mode))
    refuse();
  let commit = env.INTRODUCTION_SUPPLEMENT_COMMIT;
  if (mode === "prepare-acceptance") {
    const resolved = await githubJson(
      `repos/${declaration.supplementRepository}/commits/${encodeURIComponent(declaration.selectorRef)}`,
      "{sha}",
      env.INTRODUCTION_OPS_READ_TOKEN,
    );
    commit = resolved.sha;
  }
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(commit);
  const file = await githubJson(
    `repos/${declaration.supplementRepository}/contents/${declaration.supplementPath}?ref=${commit}`,
    "{type,path,encoding,size,content}",
    env.INTRODUCTION_OPS_READ_TOKEN,
  );
  if (
    file.type !== "file" ||
    file.path !== declaration.supplementPath ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 262144
  )
    refuse();
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length !== file.size) refuse();
  const supplementHash = createHash("sha256").update(bytes).digest("hex");
  if (mode === "accept" && supplementHash !== env.INTRODUCTION_SUPPLEMENT_HASH)
    refuse();
  return {
    supplementCommit: commit,
    supplementHash,
    value: JSON.parse(bytes.toString("utf8")),
  };
}
module.exports = { verifySupplement, readPinnedSupplement };
