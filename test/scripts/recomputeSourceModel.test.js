/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { recomputeSourceModel } from "../../scripts/deployment/recompute-source-model.cjs";

// Fixed commits, not HEAD or a branch: history is immutable, so adding an
// _infra file changes neither tree and cannot break this test. Each is a
// merged pin refresh, so its committed sourceModel is exactly the value the
// recomputation has to return from its own tree. Two of them because their
// inventories differ (25 files and 23): a wrong inventory still produces a
// plausible hash, so the count is asserted alongside the digest.
const refreshes = [
  { sha: "b14e36f2a233d65082291f00a588bd6e3e6475c4", files: 25 },
  { sha: "3e3d0461e0c1640d3be615a5fcff67e67daf4f14", files: 23 },
];

const git = (...args) => execFileSync("git", args, { stdio: "pipe" });

// A shallow CI checkout holds only the tip, so fetch exactly these two commits
// rather than making every run pay for the whole history. Silent and untouched
// when they are already present, which is every local run.
const ensureCommit = (sha) => {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
  } catch {
    git("fetch", "--no-tags", "--depth=1", "origin", sha);
  }
};

const committedPin = (sha) =>
  git("show", `${sha}:scripts/deployment/terraform-meeting-model.cjs`)
    .toString()
    .match(/sourceModel =\s*"([a-f0-9]{64})"/)?.[1];

test.each(refreshes)(
  "reproduces the pin committed at $sha over $files files",
  ({ sha, files }) => {
    ensureCommit(sha);
    const recomputed = recomputeSourceModel(sha);
    expect(recomputed.files).toHaveLength(files);
    expect(recomputed.sourceModel).toBe(committedPin(sha));
  },
);
