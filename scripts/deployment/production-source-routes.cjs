"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { parse } = require("yaml");
const { canonicalHash } = require("./production-manifest.cjs");
const receipts = new WeakMap();
const paths = [
  ["workflow", ".github/workflows/deploy.yml"],
  ["workflow", ".github/workflows/terraform-apply.yml"],
  ["manual", "scripts/force-deployment.ps1"],
];
function assertWorkflowCredentials(contents) {
  const workflow = parse(contents);
  if (
    !workflow?.jobs ||
    typeof workflow.jobs !== "object" ||
    Array.isArray(workflow.jobs)
  )
    throw Error("source_route_prerequisite");
  // Static credential inputs/references are outside the reviewed seven-role identity inventory.
  const source = JSON.stringify(workflow);
  if (
    /"(?:aws-access-key-id|aws-secret-access-key|aws-session-token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)"\s*:/i.test(
      source,
    ) ||
    /\b(?:secrets|vars)\.(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\b/.test(
      source,
    )
  )
    throw Error("unaccounted_static_credential_route");
}
function verifyDeclaredRoutes(binding) {
  const root = resolve(__dirname, "../..");
  try {
    if (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() !== binding.manifest.identity.sourceCommit
    )
      throw Error();
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "."], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw Error("source_route_prerequisite");
  }
  const expected = paths.map(([kind, id]) => {
    const contents = readFileSync(resolve(root, id), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    if (kind === "workflow") assertWorkflowCredentials(contents);
    return {
      kind,
      id,
      evidenceHash: canonicalHash({
        sourceCommit: binding.manifest.identity.sourceCommit,
        path: id,
        contents,
      }),
    };
  });
  if (
    canonicalHash(expected) !== canonicalHash(binding.manifest.launcherRoutes)
  )
    throw Error("source_route_prerequisite");
  const receipt = {};
  const path = "src/services/transcriptionPromptService.ts";
  const template = {
    path,
    sourceCommit: binding.manifest.identity.sourceCommit,
    sourceSha256: createHash("sha256")
      .update(readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n"))
      .digest("hex"),
  };
  receipts.set(receipt, { scopeHash: binding.manifestHash, template });
  return receipt;
}
function declaredRoutesVerified(receipt, scopeHash) {
  return receipts.get(receipt)?.scopeHash === scopeHash;
}
function readVerifiedFallbackTemplates(receipt, scopeHash, paths) {
  const verified = receipts.get(receipt);
  if (
    !verified ||
    verified.scopeHash !== scopeHash ||
    paths.some((path) => path !== verified.template.path)
  )
    throw Error("fallback_source_prerequisite");
  return paths.map(() => ({ ...verified.template }));
}
module.exports = {
  verifyDeclaredRoutes,
  declaredRoutesVerified,
  readVerifiedFallbackTemplates,
};
