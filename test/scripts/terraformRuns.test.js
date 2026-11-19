/** @jest-environment node */
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import {
  assertProductionIdle,
  checkPlanRetention,
  checkPlanPolicy,
  github,
  planStore,
  planSummary,
  verifyPlanRun,
  waitForApplyIdle,
} from "../../scripts/deployment/terraform-runs.cjs";

const repository = "Chronote-gg/Chronote";
const sha = "a".repeat(40);

describe("github", () => {
  test("only reads this repository's API paths", async () => {
    const requests = [];
    const get = github("token", async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ id: 1 }) };
    });
    await expect(get(`/repos/${repository}/actions/runs/1`)).resolves.toEqual({
      id: 1,
    });
    await expect(get("/repos/other/repo/actions/runs/1")).rejects.toThrow();
    expect(requests).toEqual([
      `https://api.github.com/repos/${repository}/actions/runs/1`,
    ]);
  });

  test("refuses a failed response", async () => {
    const get = github("token", async () => ({ ok: false, status: 404 }));
    await expect(get(`/repos/${repository}/actions/runs/1`)).rejects.toThrow(
      "GitHub API 404",
    );
  });
});

describe("verifyPlanRun", () => {
  const planRun = (overrides = {}) => ({
    id: 42,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: ".github/workflows/terraform-plan.yml@refs/heads/master",
    event: "workflow_dispatch",
    head_branch: "master",
    display_title: "Terraform Plan production",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    run_attempt: 1,
    ...overrides,
  });
  const verify = (run, environment = "production") =>
    verifyPlanRun(
      async (path) =>
        path.includes("/artifacts?")
          ? {
              total_count: 1,
              artifacts: [
                {
                  name: `terraform-plan-sha256-${"c".repeat(64)}`,
                  expired: false,
                },
              ],
            }
          : run,
      {
        repository,
        runId: "42",
        environment,
        sha,
        planSha256: "c".repeat(64),
      },
    );

  test("accepts a successful first-attempt master plan of the same commit", async () => {
    await expect(verify(planRun())).resolves.toMatchObject({ id: 42 });
  });

  test.each([
    ["another workflow", { path: ".github/workflows/deploy.yml@x" }],
    ["another branch", { head_branch: "feature" }],
    ["a failed plan", { conclusion: "failure" }],
    ["a running plan", { status: "in_progress", conclusion: null }],
    ["another commit", { head_sha: "b".repeat(40) }],
    ["a fork", { head_repository: { full_name: "fork/Chronote" } }],
    ["a re-run plan", { run_attempt: 2 }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(verify(planRun(overrides))).rejects.toThrow();
  });

  test("refuses a plan made for the other environment", async () => {
    await expect(verify(planRun(), "sandbox")).rejects.toThrow();
  });
});

test.each([
  [],
  [{ name: `terraform-plan-sha256-${"d".repeat(64)}`, expired: false }],
  [{ name: `terraform-plan-sha256-${"c".repeat(64)}`, expired: true }],
])(
  "refuses missing, mismatched or expired run digest %j",
  async (...artifacts) => {
    await expect(
      verifyPlanRun(
        async (path) =>
          path.includes("/artifacts?")
            ? { total_count: artifacts.length, artifacts }
            : {
                id: 42,
                repository: { full_name: repository },
                head_repository: { full_name: repository },
                path: ".github/workflows/terraform-plan.yml",
                event: "workflow_dispatch",
                head_branch: "master",
                display_title: "Terraform Plan production",
                status: "completed",
                conclusion: "success",
                head_sha: sha,
                run_attempt: 1,
              },
        {
          repository,
          runId: "42",
          environment: "production",
          sha,
          planSha256: "c".repeat(64),
        },
      ),
    ).rejects.toThrow();
  },
);

describe("checkPlanPolicy", () => {
  const account = "123456789012";
  const statement = (environment) => ({
    Effect: "Deny",
    Principal: "*",
    Action: ["s3:GetObject", "s3:GetObjectVersion"],
    Resource: `arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/${environment}/*`,
    Condition: {
      ArnNotLike: {
        "aws:PrincipalArn": [
          `meeting-notes-${environment === "production" ? "prod" : "sandbox"}-github-terraform`,
          `meeting-notes-${environment === "production" ? "prod" : "sandbox"}-github-terraform-plan`,
          "Administrator",
        ].map((name) => `arn:aws:iam::${account}:role/${name}`),
      },
    },
  });
  const policy = () => ({
    Statement: [statement("production"), statement("sandbox")],
  });
  test("the local policy check needs no GitHub token", () => {
    const directory = mkdtempSync(join(tmpdir(), "plan-policy-"));
    try {
      const path = join(directory, "policy.json");
      writeFileSync(path, JSON.stringify(policy()));
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/deployment/terraform-runs.cjs"),
          "check-plan-policy",
          path,
          account,
        ],
        { env: { ...process.env, GH_TOKEN: "" }, encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("requires isolated prefix denies for both environments", () => {
    expect(() => checkPlanPolicy(policy(), account)).not.toThrow();
    for (const environment of ["production", "sandbox"])
      expect(() =>
        checkPlanPolicy({ Statement: [statement(environment)] }, account),
      ).toThrow();
  });
  test("refuses a leftover production-only blanket deny even with both isolated statements", () => {
    const candidate = policy();
    const legacy = statement("production");
    legacy.Resource =
      "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/*";
    candidate.Statement.push(legacy);
    expect(() => checkPlanPolicy(candidate, account)).toThrow(
      "Replace the legacy shared-prefix read deny",
    );
  });
  test.each([
    {},
    { Effect: "Allow" },
    { Action: ["s3:GetObject"] },
    {
      Resource:
        "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/*",
    },
    { Condition: { ArnNotLike: { "aws:PrincipalArn": ["*"] } } },
  ])("refuses missing or weaker read restrictions %j", (override) => {
    for (const index of [0, 1]) {
      const candidate = policy();
      if (Object.keys(override).length)
        candidate.Statement[index] = {
          ...candidate.Statement[index],
          ...override,
        };
      else candidate.Statement.splice(index, 1);
      expect(() => checkPlanPolicy(candidate, account)).toThrow();
    }
  });
  test.each([
    "cross-environment role",
    "extra role",
    "duplicate role",
    "foreign account",
    "wildcard role",
    "conditional bypass",
  ])("refuses %s", (kind) => {
    for (const index of [0, 1]) {
      const candidate = policy();
      const condition = candidate.Statement[index].Condition;
      const allowed = condition.ArnNotLike["aws:PrincipalArn"];
      if (kind === "cross-environment role")
        allowed[2] =
          candidate.Statement[1 - index].Condition.ArnNotLike[
            "aws:PrincipalArn"
          ][0];
      if (kind === "extra role")
        allowed.push(`arn:aws:iam::${account}:role/Other`);
      if (kind === "duplicate role") allowed[2] = allowed[0];
      if (kind === "foreign account")
        allowed[2] = "arn:aws:iam::999999999999:role/Administrator";
      if (kind === "wildcard role")
        allowed[2] = `arn:aws:iam::${account}:role/Admin*`;
      if (kind === "conditional bypass")
        condition.Bool = { "aws:SecureTransport": "false" };
      expect(() => checkPlanPolicy(candidate, account)).toThrow();
    }
  });
});

describe("planStore", () => {
  const backend = readFileSync("_infra/main.tf", "utf8");

  test("keeps each plan run's files under its own key in the state bucket", () => {
    expect(planStore("production", "42", "1", backend)).toEqual({
      bucket: "meeting-notes-terraform-state-bucket",
      prefix: "terraform-plans/production/42-1",
    });
  });

  // Terraform lists the workspace prefix and reads state keys; plans must be
  // outside both, and outside the bootstrap roots' keys.
  test("never shares a prefix with a state key", () => {
    const { prefix } = planStore("sandbox", "7", "1", backend);
    expect(prefix.startsWith("meeting-notes-terraform")).toBe(false);
    expect(prefix).toBe("terraform-plans/sandbox/7-1");
  });

  test.each([
    ["staging", "1", "1"],
    ["production", "x", "1"],
    ["production", "1", "0"],
  ])("refuses %s run %s attempt %s", (environment, runId, attempt) => {
    expect(() => planStore(environment, runId, attempt, backend)).toThrow();
  });
});

describe("checkPlanRetention", () => {
  const expiring = (prefix, extra = {}) => ({
    ID: "plans",
    Status: "Enabled",
    Filter: { Prefix: prefix },
    Expiration: { Days: 30 },
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    ...extra,
  });

  test.each([["the plans prefix", expiring("terraform-plans/")]])(
    "accepts a rule expiring %s",
    (_name, rule) => {
      expect(() => checkPlanRetention({ Rules: [rule] })).not.toThrow();
    },
  );

  test.each([
    ["no lifecycle configuration", {}],
    ["whole bucket", { Rules: [expiring("")] }],
    [
      "marker only",
      {
        Rules: [
          expiring("terraform-plans/", {
            Expiration: { ExpiredObjectDeleteMarker: true },
          }),
        ],
      },
    ],
    [
      "too long",
      { Rules: [expiring("terraform-plans/", { Expiration: { Days: 31 } })] },
    ],
    [
      "tag filter",
      {
        Rules: [
          expiring("terraform-plans/", {
            Filter: { And: { Prefix: "terraform-plans/", Tags: [] } },
          }),
        ],
      },
    ],
    ["no rules", { Rules: [] }],
    [
      "a disabled rule",
      { Rules: [expiring("terraform-plans/", { Status: "Disabled" })] },
    ],
    ["a rule for another prefix", { Rules: [expiring("logs/")] }],
    [
      "a rule for a narrower prefix",
      { Rules: [expiring("terraform-plans/sandbox/")] },
    ],
    [
      "a rule with no expiration",
      { Rules: [{ ...expiring("terraform-plans/"), Expiration: undefined }] },
    ],
  ])("refuses %s", (_name, config) => {
    expect(() => checkPlanRetention(config)).toThrow(
      "No enabled lifecycle rule expires terraform-plans/ in the state bucket",
    );
  });

  // Versioning is on, so expiring the current version only adds a delete
  // marker; the plan bytes stay as a noncurrent version until this removes them.
  test("refuses an expiry that keeps noncurrent versions forever", () => {
    expect(() =>
      checkPlanRetention({
        Rules: [
          {
            ...expiring("terraform-plans/"),
            NoncurrentVersionExpiration: undefined,
          },
        ],
      }),
    ).toThrow(
      "No enabled lifecycle rule removes noncurrent versions under terraform-plans/",
    );
  });
});

describe("assertProductionIdle", () => {
  test("passes when no deploy run is open and checks every open status", async () => {
    const paths = [];
    await assertProductionIdle(async (path) => {
      paths.push(path);
      return { total_count: 0 };
    }, repository);
    expect(paths).toEqual(
      ["in_progress", "queued", "waiting", "pending"].map(
        (status) =>
          `/repos/${repository}/actions/workflows/deploy.yml/runs?status=${status}&per_page=1`,
      ),
    );
  });

  test("refuses while a deploy run is open", async () => {
    await expect(
      assertProductionIdle(
        async (path) => ({
          total_count: path.includes("queued") ? 1 : 0,
        }),
        repository,
      ),
    ).rejects.toThrow("Production writer deploy.yml has a queued run");
  });
});

describe("waitForApplyIdle", () => {
  const runsPath = `/repos/${repository}/actions/workflows/terraform-apply.yml/runs?status=in_progress&per_page=100`;
  const applyRun = (environment) => ({
    display_title: `Terraform Apply ${environment} plan=1`,
  });
  const page = (...environments) => ({
    total_count: environments.length,
    workflow_runs: environments.map(applyRun),
  });

  // Replays one response (or thrown error) per poll and records the clock.
  function harness(responses) {
    const calls = [];
    let clock = 0;
    const get = async (path) => {
      calls.push(path);
      const next = responses[Math.min(calls.length, responses.length) - 1];
      if (next instanceof Error) throw next;
      return next;
    };
    const wait = (environment) =>
      waitForApplyIdle(get, repository, environment, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        log: () => {},
      });
    return { calls, wait, elapsed: () => clock };
  }

  test("returns at once when no Apply is in progress", async () => {
    const h = harness([page()]);
    await expect(h.wait("production")).resolves.toBe("idle");
    expect(h.calls).toEqual([runsPath]);
    expect(h.elapsed()).toBe(0);
  });

  test("ignores an in-progress Apply for the other environment", async () => {
    await expect(harness([page("sandbox")]).wait("production")).resolves.toBe(
      "idle",
    );
    await expect(harness([page("production")]).wait("sandbox")).resolves.toBe(
      "idle",
    );
  });

  test("waits in 30 second polls until the same environment's Apply ends", async () => {
    const h = harness([page("production"), page("production"), page()]);
    await expect(h.wait("production")).resolves.toBe("idle");
    expect(h.calls).toHaveLength(3);
    expect(h.elapsed()).toBe(60000);
  });

  test("an unreadable poll counts as busy and the wait goes on", async () => {
    const h = harness([new Error("unavailable"), page()]);
    await expect(h.wait("production")).resolves.toBe("idle");
    expect(h.calls).toHaveLength(2);
  });

  // Proceeding could overlap an Apply, so an unreadable API fails the deploy,
  // but after 5 minutes and with its own message, not after the Apply hour.
  test("fails after 5 minutes of unreadable polls, naming the cause", async () => {
    const h = harness([new Error("unavailable")]);
    await expect(h.wait("production")).rejects.toThrow(
      "Terraform Apply state could not be read for 5 minutes; deploy again once the GitHub Actions API answers",
    );
    expect(h.elapsed()).toBe(5 * 60 * 1000);
  });

  test("a readable poll restarts the unreadable window", async () => {
    const unreadable = Array.from({ length: 9 }, () => new Error("down"));
    const h = harness([
      ...unreadable,
      page("production"),
      ...unreadable,
      page(),
    ]);
    await expect(h.wait("production")).resolves.toBe("idle");
    expect(h.elapsed()).toBe(19 * 30 * 1000);
  });

  test("a page that does not hold every run counts as unreadable", async () => {
    const partial = { total_count: 2, workflow_runs: [applyRun("sandbox")] };
    const h = harness([partial]);
    await expect(h.wait("production")).rejects.toThrow(
      "Terraform Apply state could not be read",
    );
  });

  test("a page that does not hold every run counts as busy", async () => {
    const partial = { total_count: 2, workflow_runs: [applyRun("sandbox")] };
    const h = harness([partial, page()]);
    await expect(h.wait("production")).resolves.toBe("idle");
    expect(h.calls).toHaveLength(2);
  });

  test("fails after 60 minutes of a running Apply", async () => {
    const h = harness([page("production")]);
    await expect(h.wait("production")).rejects.toThrow(
      "Terraform Apply for production is still in progress after 60 minutes; deploy again once it finishes",
    );
    expect(h.elapsed()).toBe(60 * 60 * 1000);
  });
});

describe("planSummary", () => {
  const secret = "SYNTHETIC-SECRET-VALUE";
  const change = (address, type, actions) => ({
    address,
    type,
    change: {
      actions,
      before: { value: secret },
      after: { value: secret },
      after_unknown: {},
      before_sensitive: {},
    },
  });
  const plan = {
    variables: { OPENAI_API_KEY: { value: secret } },
    resource_changes: [
      change("aws_s3_bucket.a", "aws_s3_bucket", ["create"]),
      change("aws_iam_policy.b", "aws_iam_policy", ["update"]),
      change("aws_lb.c", "aws_lb", ["delete", "create"]),
      change("aws_lb.d", "aws_lb", ["create", "delete"]),
      change("aws_sns_topic.e", "aws_sns_topic", ["delete"]),
      change("aws_vpc.f", "aws_vpc", ["no-op"]),
      change("data.aws_caller_identity.g", "aws_caller_identity", ["read"]),
      change("aws_kms_key_policy.h", "aws_kms_key_policy", ["update"]),
      change(
        "github_repository_environment.i",
        "github_repository_environment",
        ["update"],
      ),
      change(
        "github_actions_environment_secret.j",
        "github_actions_environment_secret",
        ["create"],
      ),
      change("aws_security_group.k", "aws_security_group", ["update"]),
      change("aws_s3_bucket_policy.l", "aws_s3_bucket_policy", ["update"]),
      change("aws_secretsmanager_secret.m", "aws_secretsmanager_secret", [
        "create",
      ]),
    ],
  };
  const meta = {
    sha,
    digest: "d".repeat(64),
    attempt: "1",
    location: "s3://example-bucket/terraform-plans/production/42-1/plan.tar.gz",
  };
  const summary = planSummary(plan, meta);

  test("never prints a value from the plan", () => {
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("OPENAI_API_KEY");
  });

  test("counts each kind of change and lists every changed address", () => {
    expect(summary).toContain(
      "3 to add, 5 to change, 2 to replace, 1 to destroy.",
    );
    for (const address of ["aws_s3_bucket.a", "aws_iam_policy.b", "aws_lb.c"])
      expect(summary).toContain(`\`${address}\``);
    expect(summary).not.toContain("aws_vpc.f");
    expect(summary).not.toContain("data.aws_caller_identity.g");
  });

  test("reports removal from state even without a provider destroy", () => {
    const text = planSummary(
      {
        resource_changes: [
          change("grafana_folder.fixture", "grafana_folder", ["forget"]),
        ],
      },
      meta,
    );
    expect(text).toContain("0 to destroy, 1 to remove from state.");
    expect(text).toContain("Remove from state");
    expect(text).toContain("`grafana_folder.fixture` remove from state");
    expect(text).not.toContain("Nothing was stored");
  });

  test("reports imports with or without a remote change", () => {
    const items = ["no-op", "update"].map((action) =>
      change(`aws_s3_bucket.${action}`, "aws_s3_bucket", [action]),
    );
    for (const item of items) item.change.importing = { id: "hidden" };
    const text = planSummary({ resource_changes: items }, meta);
    expect(text).toContain(
      "1 to change, 0 to replace, 0 to destroy, 2 to import into state.",
    );
    expect(text).toContain("`aws_s3_bucket.no-op` import into state");
    expect(text).toContain("`aws_s3_bucket.update` change");
    expect(text).not.toContain("hidden");
  });

  test("counts and lists an unfamiliar action combination", () => {
    const text = planSummary(
      {
        resource_changes: [
          change("aws_s3_bucket.fixture", "aws_s3_bucket", [
            "future",
            "update",
          ]),
        ],
      },
      meta,
    );
    expect(text).toContain("0 to destroy, 1 with other actions.");
    expect(text).toContain("`aws_s3_bucket.fixture` future,update");
  });

  test("flags security-sensitive changes and replace or destroy before the full list", () => {
    const flagged = summary.slice(0, summary.indexOf("### All changes"));
    for (const line of [
      "- **`aws_iam_policy.b` change**",
      "- **`aws_kms_key_policy.h` change**",
      "- **`github_repository_environment.i` change**",
      "- **`github_actions_environment_secret.j` add**",
      "- **`aws_security_group.k` change**",
      "- **`aws_s3_bucket_policy.l` change**",
      "- **`aws_secretsmanager_secret.m` add**",
      "- **`aws_lb.c` replace**",
      "- **`aws_sns_topic.e` destroy**",
    ])
      expect(flagged).toContain(line);
    expect(flagged).not.toContain("aws_s3_bucket.a`");
  });

  // The plan validator that used to prove production-deploy's shape is gone;
  // the owner reading these flagged lines replaces it.
  test("flags any change to the unreviewed deploy environment and its branch policy", () => {
    const text = planSummary(
      {
        resource_changes: [
          change(
            "github_repository_environment.production_deploy[0]",
            "github_repository_environment",
            ["update"],
          ),
          change(
            "github_repository_environment_deployment_policy.production_deploy_master[0]",
            "github_repository_environment_deployment_policy",
            ["create"],
          ),
        ],
      },
      meta,
    );
    const flagged = text.slice(0, text.indexOf("### All changes"));
    expect(flagged).toContain(
      "- **`github_repository_environment.production_deploy[0]` change**",
    );
    expect(flagged).toContain(
      "- **`github_repository_environment_deployment_policy.production_deploy_master[0]` add**",
    );
  });

  test("records the commit, attempt, digest and where the plan is stored", () => {
    expect(summary).toContain(`Commit: \`${sha}\``);
    expect(summary).toContain("Plan run attempt: 1");
    expect(summary).toContain(
      `Plan bundle SHA-256 (\`plan_sha256\`): \`${"d".repeat(64)}\``,
    );
    expect(summary).toContain(
      "Plan bundle: `s3://example-bucket/terraform-plans/production/42-1/plan.tar.gz`",
    );
  });

  test("a plan with no changes says so, whether or not resources are listed", () => {
    for (const empty of [{}, { resource_changes: [] }]) {
      const text = planSummary(empty, { sha, attempt: "1" });
      expect(text).toContain(
        "No changes. Nothing was stored and there is nothing to apply.",
      );
      expect(text).not.toContain("SHA-256");
    }
  });
});

describe("workflow shape", () => {
  const read = (name) =>
    parse(readFileSync(`.github/workflows/${name}`, "utf8"));
  const planJob = read("terraform-plan.yml").jobs.plan;
  const applyWorkflow = read("terraform-apply.yml");
  const applyJob = applyWorkflow.jobs.apply;
  const step = (job, name) => job.steps.find((s) => s.name === name);
  const scripts = (job) => job.steps.map((s) => s.run ?? "").join("\n");
  const raw = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

  test("both jobs run on master only", () => {
    for (const job of [planJob, applyJob])
      expect(job.steps[0].run).toBe('test "$GITHUB_REF" = refs/heads/master');
  });

  test("the plan is one full plan with no targeting", () => {
    expect(scripts(planJob)).toContain("plan -input=false");
    expect(scripts(planJob)).not.toContain("-target");
    expect(scripts(applyJob)).not.toContain("-target");
  });

  test("plans and logs go to the state bucket, never to a GitHub artifact or a passphrase", () => {
    for (const name of ["terraform-plan.yml", "terraform-apply.yml"])
      expect(raw(name)).not.toMatch(/download-artifact|openssl|PASSPHRASE/);
    const store = step(planJob, "Store plan").run;
    expect(store).toContain(
      'aws s3api put-object --bucket "$BUCKET" --key "$PREFIX/plan.tar.gz" --body "$RUNNER_TEMP/plan.tar.gz" --if-none-match "*"',
    );
    for (const job of [planJob, applyJob])
      expect(step(job, "Store log").if).toBe("always()");
  });

  test("a plan with no changes stores no plan", () => {
    expect(step(planJob, "Store plan").if).toBe(
      "steps.plan.outputs.changes == 'true'",
    );
    expect(step(planJob, "Plan").run).toContain("-detailed-exitcode");
  });

  test("Terraform output never reaches the job log", () => {
    for (const job of [planJob, applyJob]) {
      expect(job.env.TF_LOG).toBe("");
      const commands = scripts(job)
        .split("\n")
        .filter((line) => /^\s*terraform /.test(line));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands)
        expect(command).toMatch(/>>? "\$(log|RUNNER_TEMP\/plan\.json)"/);
      expect(scripts(job)).not.toMatch(/set -x/);
    }
  });

  test("the summary step writes only the redacted plan summary", () => {
    const summary = step(planJob, "Summarize changes").run;
    const writes = summary
      .split("\n")
      .filter((line) => line.includes("GITHUB_STEP_SUMMARY"));
    expect(writes).toEqual([
      'node scripts/deployment/terraform-runs.cjs plan-summary "$RUNNER_TEMP/plan.json" "$GITHUB_SHA" "$GITHUB_RUN_ATTEMPT" "$PLAN_SHA256" "$PLAN_LOCATION" >> "$GITHUB_STEP_SUMMARY"',
    ]);
    expect(summary).toContain('rm "$RUNNER_TEMP/plan.json"');
  });

  test("apply checks the plan run, idleness and the digest before it unpacks", () => {
    const names = applyJob.steps.map((s) => s.name);
    const verify = names.indexOf(
      "Verify the plan run is a successful plan of this commit",
    );
    const idle = names.indexOf("Refuse while a production deploy is open");
    const download = names.indexOf("Download and verify plan");
    expect(applyJob.steps[verify].run).toBe(
      'node scripts/deployment/terraform-runs.cjs verify-plan-run "$ENVIRONMENT" "$PLAN_RUN_ID"',
    );
    expect(applyJob.steps[idle].run).toBe(
      "node scripts/deployment/terraform-runs.cjs assert-production-idle",
    );
    expect(verify).toBeLessThan(download);
    expect(idle).toBeLessThan(download);
    const lines = step(applyJob, "Download and verify plan").run.split("\n");
    const at = (text) => lines.findIndex((line) => line.includes(text));
    expect(at("set -o pipefail")).toBe(0);
    expect(at("head-object")).toBeGreaterThan(0);
    expect(at("head-object")).toBeLessThan(at("sha256sum --check"));
    expect(at("sha256sum --check")).toBeLessThan(at("tar -tzf"));
    expect(at("tar -tzf")).toBeLessThan(at("tar -xzf"));
    expect(applyJob.env.PLAN_SHA256).toBe("${{ inputs.plan_sha256 }}");
    expect(step(applyJob, "Locate the plan").run).toBe(
      'node scripts/deployment/terraform-runs.cjs plan-store "$ENVIRONMENT" "$PLAN_RUN_ID" 1 >> "$GITHUB_OUTPUT"',
    );
  });

  // The bundle is unpacked into _infra, so it may only ever supply the saved
  // plan and the Lambda archives the plan step put in it, never Terraform
  // configuration, the lock file or the provider cache.
  test("apply unpacks only the saved plan and top-level Lambda archives", () => {
    const store = step(planJob, "Store plan").run;
    expect(store).toContain(
      'tar -czf "$RUNNER_TEMP/plan.tar.gz" tfplan $(ls *.zip 2>/dev/null)',
    );
    const download = step(applyJob, "Download and verify plan").run;
    const allowed = download.match(/grep -qvE '([^']+)'/)?.[1];
    expect(allowed).toBe("^(tfplan|[A-Za-z0-9_-]+\\.zip)$");
    const pattern = new RegExp(allowed);
    for (const name of [
      "tfplan",
      "discord_alert.zip",
      "grafana_token_rotation.zip",
    ])
      expect(pattern.test(name)).toBe(true);
    for (const name of [
      ".terraform.lock.hcl",
      ".terraform/providers/x.zip",
      "main.tf",
      "../x.zip",
      "/tmp/x.zip",
    ])
      expect(pattern.test(name)).toBe(false);
    // Every archive the plan can produce passes the same pattern.
    for (const name of readdirSync("_infra").filter((n) => n.endsWith(".tf")))
      for (const [, output] of readFileSync(`_infra/${name}`, "utf8").matchAll(
        /output_path\s*=\s*"\$\{path\.module\}\/([^"]+)"/g,
      ))
        expect(pattern.test(output)).toBe(true);
    expect(download).toContain(
      'tar -xzf "$RUNNER_TEMP/plan.tar.gz" -C _infra --no-same-owner $members',
    );
  });

  test("apply tells a missing plan apart from a failed read", () => {
    const download = step(applyJob, "Download and verify plan").run;
    expect(download).toContain('if [ "$code" = 404 ]; then');
    expect(download).toContain(
      "the plan had no changes or did not finish; there is nothing to apply",
    );
    expect(download).toContain("Reading the stored plan failed (");
    // The raw CLI message is never printed, only the code taken from it.
    expect(download).not.toMatch(/echo[^\n]*\$err/);
  });

  test("the plan refuses to run unless the state bucket expires stored plans", () => {
    const names = planJob.steps.map((s) => s.name);
    const check = names.indexOf("Check plan retention");
    expect(check).toBeGreaterThan(names.indexOf("Locate the plan store"));
    expect(check).toBeLessThan(names.indexOf("Plan"));
    const run = step(planJob, "Check plan retention").run;
    expect(run).toContain(
      'aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"',
    );
    // No configuration at all is a refusal, not a read failure.
    expect(run).toContain(
      'if [ "$code" = NoSuchLifecycleConfiguration ]; then',
    );
    expect(run).toContain(
      'node scripts/deployment/terraform-runs.cjs check-plan-retention "$RUNNER_TEMP/lifecycle.json"',
    );
    expect(run).not.toMatch(/echo[^\n]*\$err/);
  });

  // A lost log must never turn an applied change or a stored plan red.
  test("the run publishes a non-sensitive digest and checks read access before planning", () => {
    const digest = step(planJob, "Publish reviewed plan digest");
    expect(digest.with.name).toBe(
      "terraform-plan-sha256-${{ steps.bundle.outputs.sha256 }}",
    );
    expect(digest.if).toBe("steps.plan.outputs.changes == 'true'");
    expect(step(planJob, "Check plan read restriction").run).toContain(
      "check-plan-policy",
    );
    const names = planJob.steps.map((s) => s.name);
    expect(names.indexOf("Check plan read restriction")).toBeLessThan(
      names.indexOf("Plan"),
    );
    expect(step(applyJob, "Download and verify plan").run).toContain(
      "tr -d '()' || true",
    );
  });

  test("storing a log can only warn", () => {
    for (const job of [planJob, applyJob]) {
      const store = step(job, "Store log").run;
      expect(store).toMatch(
        /\|\| echo "::warning::Storing the [a-z]+ log failed/,
      );
    }
  });

  test("Sandbox Apply requires its own role without falling back to the Plan role", () => {
    const requireRole = step(applyJob, "Require the Sandbox Apply role");
    expect(requireRole.if).toBe("inputs.environment == 'sandbox'");
    expect(requireRole.env.SANDBOX_APPLY_ROLE_ARN).toBe(
      "${{ vars.SANDBOX_APPLY_ROLE_ARN }}",
    );
    expect(requireRole.run).toContain('test -n "$SANDBOX_APPLY_ROLE_ARN"');
    expect(requireRole.run).toContain("exit 1");
    const names = applyJob.steps.map((s) => s.name);
    expect(names.indexOf(requireRole.name)).toBeLessThan(
      names.indexOf("Configure AWS credentials"),
    );
    expect(
      step(applyJob, "Configure AWS credentials").with["role-to-assume"],
    ).toBe(
      "${{ vars[inputs.environment == 'sandbox' && 'SANDBOX_APPLY_ROLE_ARN' || 'TERRAFORM_AWS_ROLE_ARN'] }}",
    );
    expect(
      step(planJob, "Configure AWS credentials").with["role-to-assume"],
    ).toBe("${{ vars.TERRAFORM_AWS_ROLE_ARN }}");
  });

  test("the Apply session lasts as long as the Apply job may", () => {
    const credentials = step(applyJob, "Configure AWS credentials").with;
    expect(credentials["role-duration-seconds"]).toBe(
      applyJob["timeout-minutes"] * 60,
    );
  });

  test("apply applies the saved plan and takes the three reviewed inputs", () => {
    expect(step(applyJob, "Apply the saved plan").run).toContain(
      "apply -input=false -lock-timeout=5m tfplan",
    );
    expect(Object.keys(applyWorkflow.on.workflow_dispatch.inputs)).toEqual([
      "environment",
      "plan_run_id",
      "plan_sha256",
    ]);
    expect(applyWorkflow.concurrency.group).toBe(
      "chronote-terraform-${{ inputs.environment }}",
    );
  });
});

describe("Terraform roles and environments", () => {
  const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const workflow = (file) => parse(read(`.github/workflows/${file}`));
  const role = read("_infra/production-bootstrap/terraform-role.tf");
  // Each aws_iam_role block with the environment and workflow its trust pins.
  const trusts = Object.fromEntries(
    [
      ...role.matchAll(
        /^resource "aws_iam_role" "(\w+)" \{\n([\s\S]*?)\n\}$/gm,
      ),
    ].map(([, label, body]) => [
      label,
      {
        environment: body.match(/:environment:([\w-]+)"/)?.[1],
        workflow: body.match(
          /githubusercontent\.com:workflow"\s*=\s*"([^"]+)"/,
        )?.[1],
      },
    ]),
  );

  test("the Apply role trusts only the Apply workflow in its own environment", () => {
    const apply = workflow("terraform-apply.yml");
    expect(trusts.production_terraform).toEqual({
      environment: "production-terraform",
      workflow: apply.name,
    });
    expect(apply.jobs.apply.environment).toBe(
      "${{ inputs.environment == 'production' && 'production-terraform' || 'sandbox' }}",
    );
  });

  test("the Plan role trusts only the Plan workflow in production", () => {
    const plan = workflow("terraform-plan.yml");
    expect(trusts.production_terraform_plan).toEqual({
      environment: "production",
      workflow: plan.name,
    });
    expect(plan.jobs.plan.environment).toBe("${{ inputs.environment }}");
  });

  test("Terraform never manages the Apply environment", () => {
    for (const name of readdirSync("_infra").filter((n) => n.endsWith(".tf")))
      expect(read(`_infra/${name}`)).not.toMatch(/"production-terraform"/);
  });

  test("neither workflow narrows its role with a session policy", () => {
    for (const [file, job] of [
      ["terraform-plan.yml", "plan"],
      ["terraform-apply.yml", "apply"],
    ]) {
      const credentials = workflow(file).jobs[job].steps.find(
        (s) => s.name === "Configure AWS credentials",
      ).with;
      expect(credentials["managed-session-policies"]).toBeUndefined();
      expect(credentials["inline-session-policy"]).toBeUndefined();
    }
  });
});
