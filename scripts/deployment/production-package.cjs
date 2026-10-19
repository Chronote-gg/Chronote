"use strict";
const { z } = require("zod");
const {
  canonicalHash,
  bindExecution,
  parseExecution,
} = require("./production-manifest.cjs");
const slots = ["runId", "runAttempt", "sessionName"];
const schema = z
  .object({
    schemaVersion: z.literal(1),
    manifest: z.record(z.string(), z.unknown()),
    identitySlots: z.tuple([
      z.literal("runId"),
      z.literal("runAttempt"),
      z.literal("sessionName"),
    ]),
    repositoryId: z.string().regex(/^\d+$/),
    repositoryOwnerId: z.string().regex(/^\d+$/),
  })
  .strict();
function reviewedPackage(input) {
  const p = schema.parse(input);
  if (!slots.every((key) => p.manifest.identity[key] === "$CURRENT"))
    throw new Error("package_refused");
  parseExecution(p.manifest, canonicalHash(p.manifest));
  return p;
}
function packageIntentHash(input) {
  // Every non-identity field remains bound, including prerequisites and fixture intent.
  const p = structuredClone(reviewedPackage(input));
  for (const slot of slots) delete p.manifest.identity[slot];
  return canonicalHash(p);
}
function materializePackage(input, approvedHash, context, caller) {
  const p = reviewedPackage(input);
  if (
    packageIntentHash(p) !== approvedHash ||
    p.repositoryId !== context.repositoryId ||
    p.repositoryOwnerId !== context.repositoryOwnerId
  )
    throw new Error("package_refused");
  const manifest = structuredClone(p.manifest);
  for (const slot of slots) manifest.identity[slot] = context[slot];
  const { repositoryId, repositoryOwnerId, ...job } = context;
  return {
    packageIntentHash: approvedHash,
    binding: bindExecution(manifest, job, caller),
  };
}
module.exports = { materializePackage, packageIntentHash };
