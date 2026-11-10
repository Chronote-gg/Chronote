"use strict";
const { z } = require("zod");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .object({
    pk: z.literal("ENV"),
    sk: z.literal("INTRODUCTION"),
    operationId: z.string().uuid(),
    manifestSha256: hash,
    principalArn: z.string(),
    stage: z.literal("complete"),
    previousOperationId: z.string().uuid().optional(),
    previousManifestSha256: hash.optional(),
  })
  .strict()
  .refine(
    (row) =>
      (row.previousOperationId === undefined) ===
      (row.previousManifestSha256 === undefined),
  );
function isCompletedSandboxIntroduction(value, { tablePrefix, image }) {
  if (!/(^|-)sandbox-$/.test(tablePrefix)) return false;
  const account = image.match(
    /^([0-9]{12})\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\//,
  )?.[1];
  if (!account) return false;
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) return false;
  const row = parsed.data;
  const session =
    "chronote-sandbox-" +
    BigInt("0x" + row.operationId.replaceAll("-", "")) +
    "-1";
  return new RegExp(
    "^arn:aws:sts::" +
      account +
      ":assumed-role/" +
      tablePrefix +
      "github-deploy/" +
      session +
      "$",
  ).test(row.principalArn);
}
module.exports = { isCompletedSandboxIntroduction };
