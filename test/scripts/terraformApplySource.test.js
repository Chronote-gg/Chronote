/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import {
  nativeGitHub,
  verifyApplySource,
} from "../../scripts/deployment/terraform-native.cjs";

const repository = "Chronote-gg/Chronote";
const planSha = "a".repeat(40);
const applySha = "b".repeat(40);
function compare(files, status = "ahead") {
  const calls = [];
  const get = async (path, options) => {
    calls.push({ path, options });
    return {
      status,
      merge_base_commit: { sha: status === "ahead" ? planSha : "c".repeat(40) },
      files: files.map((filename) => ({ filename })),
    };
  };
  return { calls, get };
}
const check = (get, head = applySha) =>
  verifyApplySource(get, repository, planSha, head);

test("accepts the plan's own commit without asking GitHub", async () => {
  const { calls, get } = compare([]);
  await expect(check(get, planSha)).resolves.toBe("identical");
  expect(calls).toHaveLength(0);
});

test("accepts a descendant whose changes leave Terraform inputs alone", async () => {
  const { calls, get } = compare([
    "docs/production-introduction.md",
    "src/frontend/App.tsx",
    "scripts/check-agent-tooling.mjs",
    ".github/workflows/deploy.yml",
  ]);
  await expect(check(get)).resolves.toBe("ahead");
  expect(calls).toEqual([
    {
      path: `/repos/${repository}/compare/${planSha}...${applySha}?per_page=1`,
      options: { paginated: true, maxBytes: 16777216 },
    },
  ]);
});

test.each([
  "_infra/main.tf",
  "_infra/functions/frontend-route-rewrite.js",
  "scripts/deployment/terraform-workflow.cjs",
  "patches/@discordjs+voice+0.19.0.patch",
  ".yarn/releases/yarn.cjs",
  ".github/workflows/terraform-plan.yml",
  ".github/workflows/terraform-apply.yml",
  "package.json",
  "yarn.lock",
  ".nvmrc",
  ".node-version",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "scripts/ci-install-dependencies.sh",
])("refuses a descendant that changes %s", async (path) => {
  const { get } = compare(["docs/a.md", path]);
  await expect(check(get)).rejects.toThrow(
    `Terraform input changed since the reviewed plan: ${path}`,
  );
});

test("refuses a rename out of the Terraform inputs", async () => {
  const get = async () => ({
    status: "ahead",
    merge_base_commit: { sha: planSha },
    files: [{ filename: "docs/old.tf", previous_filename: "_infra/old.tf" }],
  });
  await expect(check(get)).rejects.toThrow("_infra/old.tf");
});

test.each(["behind", "diverged"])(
  "refuses an Apply source that is %s the plan",
  async (status) => {
    const { get } = compare([], status);
    await expect(check(get)).rejects.toThrow("must descend");
  },
);

test("refuses a comparison too large to list every changed file", async () => {
  const { get } = compare(
    Array.from({ length: 300 }, (_, i) => `docs/${i}.md`),
  );
  await expect(check(get)).rejects.toThrow("Too many changed files");
});

test("refuses as UNKNOWN when the comparison is unavailable", async () => {
  const get = nativeGitHub("fake-token", async () => ({
    ok: false,
    headers: { get: () => null },
    body: [],
  }));
  await expect(check(get)).rejects.toThrow(
    "UNKNOWN: plan and Apply source comparison unavailable",
  );
});

test("only an explicitly paginated read accepts a Link header", async () => {
  const get = nativeGitHub("fake-token", async () => ({
    ok: true,
    headers: { get: () => '<https://api.github.com/x?page=2>; rel="next"' },
    body: [Buffer.from("{}")],
  }));
  await expect(get(`/repos/${repository}/actions/runs/1`)).rejects.toThrow(
    "UNKNOWN",
  );
  await expect(
    get(`/repos/${repository}/compare/${planSha}...${applySha}?per_page=1`, {
      paginated: true,
    }),
  ).resolves.toEqual({});
});
