/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import {
  nativeGitHub,
  verifyApproval,
  verifyRun,
} from "../../scripts/deployment/terraform-native.cjs";
import {
  nativeEnvironment,
  nativeBranchPolicies,
} from "../fixtures/deployment/terraformWorkflow.js";
const repository = "Chronote-gg/Chronote",
  sourceSha = "a".repeat(40);
const invocation = {
  repository,
  sourceSha,
  workflowPath: ".github/workflows/terraform-apply.yml",
  runId: "20",
  runAttempt: 1,
  environment: "production",
  workspace: "default",
  scope: "full",
};
const reviewInputs = {
  producerRunId: "10",
  planSha256: "b".repeat(64),
  bundleSha256: "c".repeat(64),
};
const run = {
  display_title: `Terraform Apply production/default/full plan=10 plan-sha=${reviewInputs.planSha256} bundle-sha=${reviewInputs.bundleSha256}`,
  id: 20,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  head_sha: sourceSha,
  head_branch: "master",
  path: invocation.workflowPath,
  event: "workflow_dispatch",
  run_attempt: 1,
  status: "in_progress",
  conclusion: null,
  created_at: "2026-10-20T10:00:00Z",
  actor: { id: 1 },
  triggering_actor: { id: 1 },
};
const environment = nativeEnvironment();
const approvals = [
  {
    state: "approved",
    comment: "Reviewed",
    environments: [{ id: 7, name: "production" }],
    user: { id: 2, type: "User" },
  },
];
function fixture() {
  const data = {
    run: structuredClone(run),
    environment: structuredClone(environment),
    approvals: structuredClone(approvals),
    customRules: { total_count: 0, custom_deployment_protection_rules: [] },
    branchPolicies: nativeBranchPolicies(),
    branchLink: false,
    branchUnavailable: false,
  };
  const requests = [];
  const get = nativeGitHub("fake-token", async (url, options) => {
    expect(options.headers.Authorization).toBe("Bearer fake-token");
    expect(options.redirect).toBe("error");
    requests.push(url);
    const value = url.endsWith("/deployment_protection_rules")
      ? data.customRules
      : url.endsWith("/approvals")
        ? data.approvals
        : url.includes("/deployment-branch-policies?")
          ? data.branchPolicies
          : url.includes("/environments/")
            ? data.environment
            : data.run;
    return {
      ok: !(
        url.includes("/deployment-branch-policies?") && data.branchUnavailable
      ),
      headers: {
        get: () =>
          url.includes("/deployment-branch-policies?") && data.branchLink
            ? "<next>; rel=next"
            : null,
      },
      body: [Buffer.from(JSON.stringify(value))],
    };
  });
  return { data, get, requests };
}
test("authenticated native individual review authorizes one exact first-attempt run", async () => {
  const f = fixture();
  expect(await verifyRun(f.get, invocation, false, reviewInputs)).toEqual(run);
  const proof = await verifyApproval(f.get, invocation, reviewInputs);
  expect(proof.environment.id).toBe(7);
  expect(proof.review.user.id).toBe(2);
  expect(
    f.requests.every((url) =>
      url.startsWith("https://api.github.com/repos/Chronote-gg/Chronote/"),
    ),
  ).toBe(true);
});
test.each([
  "missing-bypass",
  "null-bypass",
  "bypass",
  "no-review",
  "foreign-reviewer",
  "self-review",
  "team",
  "missing-rules",
  "unsupported-rule",
  "recent-config",
  "foreign-environment",
  "rejected",
  "multiple-reviews",
  "rerun",
  "foreign-source",
  "foreign-repository",
  "foreign-workflow",
  "event",
])("native approval refuses %s", async (fault) => {
  const f = fixture(),
    d = f.data;
  const mutations = {
    "missing-bypass": () => {
      delete d.environment.can_admins_bypass;
    },
    "null-bypass": () => {
      d.environment.can_admins_bypass = null;
    },
    bypass: () => {
      d.environment.can_admins_bypass = true;
    },
    "no-review": () => {
      d.approvals = [];
    },
    "foreign-reviewer": () => {
      d.approvals[0].user.id = 3;
    },
    "self-review": () => {
      d.approvals[0].user.id = 1;
    },
    team: () => {
      d.environment.protection_rules[0].reviewers[0].type = "Team";
    },
    "missing-rules": () => {
      d.environment.protection_rules = [];
    },
    "unsupported-rule": () => {
      d.environment.protection_rules.push({ type: "wait_timer" });
    },
    "recent-config": () => {
      d.environment.updated_at = run.created_at;
    },
    "foreign-environment": () => {
      d.approvals[0].environments[0].id = 8;
    },
    rejected: () => {
      d.approvals[0].state = "rejected";
    },
    "multiple-reviews": () => {
      d.approvals.push(d.approvals[0]);
    },
    rerun: () => {
      d.run.run_attempt = 2;
    },
    "foreign-source": () => {
      d.run.head_sha = "b".repeat(40);
    },
    "foreign-repository": () => {
      d.run.repository.full_name = "other/repo";
    },
    "foreign-workflow": () => {
      d.run.path = ".github/workflows/other.yml";
    },
    event: () => {
      d.run.event = "push";
    },
  };
  mutations[fault]();
  await expect(
    verifyApproval(f.get, invocation, reviewInputs),
  ).rejects.toThrow();
});
test("native transport refuses unauthenticated, nonterminal and oversized metadata without raw errors", async () => {
  expect(() => nativeGitHub("")).toThrow();
  const get = nativeGitHub("fake-token", async () => {
    throw new Error("SECRET_SENTINEL");
  });
  await expect(
    get("/repos/Chronote-gg/Chronote/actions/runs/20"),
  ).rejects.toThrow("UNKNOWN: GitHub metadata unavailable");
  const f = fixture();
  await expect(
    verifyRun(f.get, invocation, true, reviewInputs),
  ).rejects.toThrow();
});
export { fixture, invocation, run };

test("native producer provenance rejects a changed environment/workspace/scope title", async () => {
  const f = fixture();
  f.data.run.path = ".github/workflows/terraform-plan.yml";
  f.data.run.display_title = "Terraform Plan sandbox/sandbox/full";
  await expect(
    verifyRun(
      f.get,
      { ...invocation, workflowPath: ".github/workflows/terraform-plan.yml" },
      false,
    ),
  ).rejects.toThrow();
});

test.each(["oversized", "non-json", "http-failure", "pagination"])(
  "native transport refuses %s metadata",
  async (fault) => {
    const get = nativeGitHub("fake-token", async () => ({
      ok: fault !== "http-failure",
      headers: { get: () => (fault === "pagination" ? "next" : null) },
      body: [
        Buffer.from(fault === "oversized" ? "x".repeat(1048577) : "not-json"),
      ],
    }));
    await expect(
      get("/repos/Chronote-gg/Chronote/actions/runs/20"),
    ).rejects.toThrow("UNKNOWN: GitHub metadata unavailable");
  },
);
test.each(["false", 0, {}, []])(
  "native bypass value %s never defaults to false",
  async (value) => {
    const f = fixture();
    f.data.environment.can_admins_bypass = value;
    await expect(
      verifyApproval(f.get, invocation, reviewInputs),
    ).rejects.toThrow();
  },
);

test.each([
  "custom-rule",
  "missing-custom-count",
  "missing-actor-id",
  "missing-trigger-id",
])("native approval refuses %s", async (fault) => {
  const f = fixture();
  const mutations = {
    "custom-rule": () => {
      f.data.customRules = {
        total_count: 1,
        custom_deployment_protection_rules: [{ id: 8 }],
      };
    },
    "missing-custom-count": () => {
      delete f.data.customRules.total_count;
    },
    "missing-actor-id": () => {
      delete f.data.run.actor.id;
    },
    "missing-trigger-id": () => {
      delete f.data.run.triggering_actor.id;
    },
  };
  mutations[fault]();
  await expect(
    verifyApproval(f.get, invocation, reviewInputs),
  ).rejects.toThrow();
});

function selfReviewFixture() {
  const f = fixture();
  f.data.environment.protection_rules[0].prevent_self_review = false;
  f.data.environment.protection_rules[0].reviewers[0].reviewer.id = 1;
  f.data.approvals[0].user.id = 1;
  return f;
}
test("native false self-review setting permits the dispatcher's explicit approved review", async () => {
  const f = selfReviewFixture();
  const proof = await verifyApproval(f.get, invocation, reviewInputs);
  expect(proof.review.user.id).toBe(f.data.run.actor.id);
  expect(proof.environment.protection_rules[0].prevent_self_review).toBe(false);
});
test.each(["actor", "triggering_actor"])(
  "native true self-review setting refuses the %s's review",
  async (actor) => {
    const f = selfReviewFixture();
    f.data.environment.protection_rules[0].prevent_self_review = true;
    f.data.run.actor.id = 3;
    f.data.run.triggering_actor.id = 4;
    f.data.run[actor].id = 1;
    await expect(
      verifyApproval(f.get, invocation, reviewInputs),
    ).rejects.toThrow();
  },
);
test.each([undefined, null, "false", 0, {}, []])(
  "malformed self-review setting %s never grants approval",
  async (value) => {
    const f = selfReviewFixture();
    f.data.environment.protection_rules[0].prevent_self_review = value;
    await expect(
      verifyApproval(f.get, invocation, reviewInputs),
    ).rejects.toThrow();
  },
);
test.each([
  "missing-review",
  "rejected",
  "stale-run",
  "recent-config",
  "foreign-reviewer",
  "foreign-environment",
  "bypass",
])("self-review profile refuses %s evidence", async (fault) => {
  const f = selfReviewFixture();
  const mutations = {
    "missing-review": () => {
      f.data.approvals = [];
    },
    rejected: () => {
      f.data.approvals[0].state = "rejected";
    },
    "stale-run": () => {
      f.data.run.id = 19;
    },
    "recent-config": () => {
      f.data.environment.updated_at = f.data.run.created_at;
    },
    "foreign-reviewer": () => {
      f.data.approvals[0].user.id = 3;
    },
    "foreign-environment": () => {
      f.data.approvals[0].environments[0].id = 8;
    },
    bypass: () => {
      f.data.environment.can_admins_bypass = true;
    },
  };
  mutations[fault]();
  await expect(
    verifyApproval(f.get, invocation, reviewInputs),
  ).rejects.toThrow();
});

test("production approval retains the complete authenticated exact-master branch proof", async () => {
  const f = fixture();
  f.data.environment.protection_rules.reverse();
  const proof = await verifyApproval(f.get, invocation, reviewInputs);
  expect(proof.branchPolicies).toEqual(nativeBranchPolicies());
  expect(f.requests).toContain(
    "https://api.github.com/repos/Chronote-gg/Chronote/environments/production/deployment-branch-policies?per_page=100",
  );
});

test("Sandbox keeps its existing reviewer-only profile without a production branch-policy lookup", async () => {
  const f = fixture();
  f.data.environment = nativeEnvironment("sandbox");
  f.data.approvals[0].environments[0].name = "sandbox";
  f.data.run.display_title = f.data.run.display_title.replace(
    "production/default/full",
    "sandbox/sandbox/full",
  );
  await expect(
    verifyApproval(
      f.get,
      { ...invocation, environment: "sandbox", workspace: "sandbox" },
      reviewInputs,
    ),
  ).resolves.toMatchObject({ environment: { deployment_branch_policy: null } });
  expect(
    f.requests.some((url) => url.includes("deployment-branch-policies")),
  ).toBe(false);
});

test.each([
  "null-profile",
  "protected-branches",
  "missing-branch-rule",
  "duplicate-rule",
  "missing-count",
  "extra-policy",
  "missing-type",
  "tag",
  "wildcard",
  "foreign-branch",
  "foreign-run-branch",
])("production approval refuses %s branch proof", async (fault) => {
  const f = fixture();
  const mutations = {
    "null-profile": () => {
      f.data.environment.deployment_branch_policy = null;
      f.data.environment.protection_rules.pop();
    },
    "protected-branches": () => {
      f.data.environment.deployment_branch_policy.protected_branches = true;
    },
    "missing-branch-rule": () => {
      f.data.environment.protection_rules.pop();
    },
    "duplicate-rule": () => {
      f.data.environment.protection_rules.push({ type: "branch_policy" });
    },
    "missing-count": () => {
      delete f.data.branchPolicies.total_count;
    },
    "extra-policy": () => {
      f.data.branchPolicies.total_count = 2;
      f.data.branchPolicies.branch_policies.push({
        id: 12,
        name: "other",
        type: "branch",
      });
    },
    "missing-type": () => {
      delete f.data.branchPolicies.branch_policies[0].type;
    },
    tag: () => {
      f.data.branchPolicies.branch_policies[0].type = "tag";
    },
    wildcard: () => {
      f.data.branchPolicies.branch_policies[0].name = "*";
    },
    "foreign-branch": () => {
      f.data.branchPolicies.branch_policies[0].name = "other";
    },
    "foreign-run-branch": () => {
      f.data.run.head_branch = "other";
    },
  };
  mutations[fault]();
  await expect(
    verifyApproval(f.get, invocation, reviewInputs),
  ).rejects.toThrow();
});

test.each([
  "linked-page",
  "unavailable",
  "missing-proof",
  "empty-list",
  "count-mismatch",
  "missing-flags",
])(
  "production approval refuses incomplete branch evidence: %s",
  async (fault) => {
    const f = fixture();
    if (fault === "linked-page") f.data.branchLink = true;
    if (fault === "unavailable") f.data.branchUnavailable = true;
    if (fault === "missing-proof") f.data.branchPolicies = null;
    if (fault === "empty-list") f.data.branchPolicies.branch_policies = [];
    if (fault === "count-mismatch")
      f.data.branchPolicies.branch_policies.push({
        id: 12,
        name: "other",
        type: "branch",
      });
    if (fault === "missing-flags")
      delete f.data.environment.deployment_branch_policy.custom_branch_policies;
    await expect(
      verifyApproval(f.get, invocation, reviewInputs),
    ).rejects.toThrow();
  },
);
