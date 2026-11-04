"use strict";
// Recomputes terraform-meeting-model.cjs's sourceModel pin over a committed
// _infra tree, reusing the inventory predicate and digest that verifySource
// applies to a checkout so the two cannot disagree.
// Usage: node scripts/deployment/recompute-source-model.cjs [git-ref]
// Recomputation contract: docs/terraform-meeting-source-model.md.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { bindingHash } = require("./binding-hash.cjs");
const { isSource, modelDigest } = require("./terraform-meeting-model.cjs");

function recomputeSourceModel(
  ref = "HEAD",
  directory = join(__dirname, "../.."),
) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      windowsHide: true,
      maxBuffer: 1 << 28,
    });
  const files = git("ls-tree", "--name-only", `${ref}:_infra`)
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(isSource)
    .sort();
  assert.ok(files.length > 0, "No Terraform source in tree");
  const manifest = {};
  for (const name of files)
    manifest[name] = modelDigest(git("show", `${ref}:_infra/${name}`));
  return { files, sourceModel: bindingHash(manifest) };
}
module.exports = { recomputeSourceModel };
if (require.main === module) {
  assert.ok(process.argv.length <= 3, "Usage: recompute-source-model [ref]");
  const ref = process.argv[2] ?? "HEAD";
  const { files, sourceModel } = recomputeSourceModel(ref);
  process.stdout.write(
    `ref: ${ref}\nfiles: ${files.length}\n` +
      files.map((name) => `  ${name}\n`).join("") +
      `sourceModel: ${sourceModel}\n`,
  );
}
