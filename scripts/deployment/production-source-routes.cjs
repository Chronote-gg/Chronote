"use strict";
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { canonicalHash } = require("./production-manifest.cjs");
const receipts = new WeakMap();
const paths = [
  ["workflow", ".github/workflows/deploy.yml"],
  ["workflow", ".github/workflows/terraform-apply.yml"],
  ["manual", "scripts/force-deployment.ps1"],
];
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
  const expected = paths.map(([kind, id]) => ({
    kind,
    id,
    evidenceHash: canonicalHash({
      sourceCommit: binding.manifest.identity.sourceCommit,
      path: id,
      contents: readFileSync(resolve(root, id), "utf8").replace(/\r\n/g, "\n"),
    }),
  }));
  if (
    canonicalHash(expected) !== canonicalHash(binding.manifest.launcherRoutes)
  )
    throw Error("source_route_prerequisite");
  const receipt = {};
  receipts.set(receipt, binding.manifestHash);
  return receipt;
}
function declaredRoutesVerified(receipt, scopeHash) {
  return receipts.get(receipt) === scopeHash;
}
module.exports = { verifyDeclaredRoutes, declaredRoutesVerified };
