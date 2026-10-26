"use strict";
const assert = require("node:assert/strict");
const {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  existsSync,
} = require("node:fs");
const { join } = require("node:path");
const { z } = require("zod");
const { digest } = require("./collector-payload.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const invocationSchema = z
  .object({
    repository: z.literal("Chronote-gg/Chronote"),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    workflowPath: z.enum([
      ".github/workflows/terraform-plan.yml",
      ".github/workflows/terraform-apply.yml",
    ]),
    runId: z.string().regex(/^[1-9]\d{0,15}$/),
    runAttempt: z.literal(1),
    environment: z.enum(["production", "sandbox"]),
    workspace: z.enum(["default", "sandbox"]),
    scope: z.enum([
      "full",
      "purchase-permission",
      "deployment-prerequisites",
      "meeting-update-delivery",
    ]),
  })
  .strict();
const zipNames = ["discord_alert.zip", "grafana_token_rotation.zip"];
const requiredNames = [
  "tfplan",
  "tfplan.sha256",
  "lambda-zips.sha256",
  "terraform-review.txt",
  "terraform-output.json",
];
const fileSchema = z
  .object({
    name: z.enum([...requiredNames, ...zipNames]),
    sha256: hash,
    size: z.number().int().nonnegative().max(33554432),
    base64: z.string().max(44739244),
  })
  .strict();
const bundleSchema = z
  .object({
    kind: z.literal("terraform-plan-bundle-v1"),
    invocation: invocationSchema,
    terraformVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    lockfileSha256: hash,
    files: z.array(fileSchema).min(5).max(7),
  })
  .strict();
function parseInvocation(value) {
  const parsed = invocationSchema.parse(value);
  assert.equal(
    parsed.workspace,
    parsed.environment === "production" ? "default" : "sandbox",
  );
  if (parsed.environment === "sandbox")
    assert.equal(
      parsed.scope,
      "meeting-update-delivery",
      "Sandbox supports only meeting-update-delivery",
    );
  if (parsed.scope === "meeting-update-delivery")
    assert.equal(parsed.environment, "sandbox");
  return parsed;
}
function encodedFile(name, bytes) {
  return {
    name,
    sha256: digest(bytes),
    size: bytes.length,
    base64: bytes.toString("base64"),
  };
}
function sourceFile(directory, name) {
  const path = join(directory, name),
    stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 33554432);
  return readFileSync(path);
}
function zipChecksums(files) {
  return files
    .filter((file) => zipNames.includes(file.name))
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join("");
}
function createBundle({
  invocation,
  terraformVersion,
  lockfileSha256,
  directory,
  review,
  output,
}) {
  parseInvocation(invocation);
  assert.equal(invocation.workflowPath, ".github/workflows/terraform-plan.yml");
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".zip"))
    .sort();
  assert.ok(names.every((name) => zipNames.includes(name)));
  const files = ["tfplan", ...names].map((name) =>
    encodedFile(name, sourceFile(directory, name)),
  );
  files.push(encodedFile("tfplan.sha256", Buffer.from(files[0].sha256 + "\n")));
  files.push(
    encodedFile("lambda-zips.sha256", Buffer.from(zipChecksums(files))),
  );
  files.push(encodedFile("terraform-review.txt", review));
  files.push(
    encodedFile("terraform-output.json", Buffer.from(JSON.stringify(output))),
  );
  const bundle = {
    kind: "terraform-plan-bundle-v1",
    invocation: structuredClone(invocation),
    terraformVersion,
    lockfileSha256,
    files,
  };
  bundleSchema.parse(bundle);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= 33554432);
  return bundle;
}
function verifyBundle(value, expected) {
  assert.equal(
    digest(JSON.stringify(value)),
    hash.parse(expected.bundleSha256),
  );
  const bundle = bundleSchema.parse(value);
  parseInvocation(bundle.invocation);
  assert.deepEqual(bundle.invocation, expected.invocation);
  assert.equal(
    bundle.invocation.workflowPath,
    ".github/workflows/terraform-plan.yml",
  );
  assert.equal(bundle.terraformVersion, expected.terraformVersion);
  assert.equal(bundle.lockfileSha256, expected.lockfileSha256);
  const files = new Map();
  for (const file of bundle.files) {
    assert.ok(!files.has(file.name));
    const bytes = Buffer.from(file.base64, "base64");
    assert.equal(bytes.toString("base64"), file.base64);
    assert.equal(bytes.length, file.size);
    assert.equal(digest(bytes), file.sha256);
    files.set(file.name, bytes);
  }
  assert.ok(requiredNames.every((name) => files.has(name)));
  assert.equal(digest(files.get("tfplan")), hash.parse(expected.planSha256));
  assert.equal(
    files.get("tfplan.sha256").toString(),
    expected.planSha256 + "\n",
  );
  assert.equal(
    files.get("lambda-zips.sha256").toString(),
    zipChecksums(bundle.files),
  );
  return files;
}
function restoreBundle(files, directory) {
  for (const name of files.keys()) {
    assert.ok([...requiredNames, ...zipNames].includes(name));
    assert.ok(!existsSync(join(directory, name)), "Restore destination exists");
  }
  for (const [name, bytes] of files)
    writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
}
module.exports = { parseInvocation, createBundle, verifyBundle, restoreBundle };
