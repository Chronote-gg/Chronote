/** @jest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import {
  assertProductionIdle,
  github,
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
    ...overrides,
  });
  const verify = (run, environment = "production") =>
    verifyPlanRun(async () => run, {
      repository,
      runId: "42",
      environment,
      sha,
    });

  test("accepts a successful master plan of the same commit", async () => {
    await expect(verify(planRun())).resolves.toMatchObject({ id: 42 });
  });

  test.each([
    ["another workflow", { path: ".github/workflows/deploy.yml@x" }],
    ["another branch", { head_branch: "feature" }],
    ["a failed plan", { conclusion: "failure" }],
    ["a running plan", { status: "in_progress", conclusion: null }],
    ["another commit", { head_sha: "b".repeat(40) }],
    ["a fork", { head_repository: { full_name: "fork/Chronote" } }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(verify(planRun(overrides))).rejects.toThrow();
  });

  test("refuses a plan made for the other environment", async () => {
    await expect(verify(planRun(), "sandbox")).rejects.toThrow();
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
  const change = (address, actions) => ({
    address,
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
      change("aws_s3_bucket.a", ["create"]),
      change("aws_iam_policy.b", ["update"]),
      change("aws_lb.c", ["delete", "create"]),
      change("aws_lb.d", ["create", "delete"]),
      change("aws_sns_topic.e", ["delete"]),
      change("aws_vpc.f", ["no-op"]),
      change("data.aws_caller_identity.g", ["read"]),
    ],
  };
  const summary = planSummary(plan, { sha, digest: "d".repeat(64) });

  test("never prints a value from the plan", () => {
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("OPENAI_API_KEY");
  });

  test("counts each kind of change and lists every changed address", () => {
    expect(summary).toContain(
      "1 to add, 1 to change, 2 to replace, 1 to destroy.",
    );
    for (const address of [
      "aws_s3_bucket.a",
      "aws_iam_policy.b",
      "aws_lb.c",
      "aws_sns_topic.e",
    ])
      expect(summary).toContain(`\`${address}\``);
    expect(summary).not.toContain("aws_vpc.f");
    expect(summary).not.toContain("data.aws_caller_identity.g");
  });

  test("calls out replace and destroy before the full list", () => {
    const warning = summary.indexOf("Replace or destroy");
    expect(warning).toBeGreaterThan(0);
    expect(warning).toBeLessThan(summary.indexOf("All changes"));
    expect(summary).toContain("- **`aws_lb.c` replace**");
    expect(summary).toContain("- **`aws_sns_topic.e` destroy**");
  });

  test("records the commit and the encrypted plan digest", () => {
    expect(summary).toContain(`Commit: \`${sha}\``);
    expect(summary).toContain(`Encrypted plan SHA-256: \`${"d".repeat(64)}\``);
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

  test("both jobs run in the chosen environment, on master only", () => {
    for (const job of [planJob, applyJob]) {
      expect(job.environment).toBe("${{ inputs.environment }}");
      expect(job.steps[0].run).toBe('test "$GITHUB_REF" = refs/heads/master');
    }
  });

  test("the plan is one full plan with no targeting", () => {
    expect(scripts(planJob)).toContain("plan -input=false");
    expect(scripts(planJob)).not.toContain("-target");
    expect(scripts(applyJob)).not.toContain("-target");
  });

  test("only the encrypted bundle is uploaded, for one day", () => {
    const uploads = planJob.steps.filter((s) =>
      String(s.uses).startsWith("actions/upload-artifact"),
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with.path).toBe("${{ runner.temp }}/plan.tgz.enc");
    expect(uploads[0].with["retention-days"]).toBe(1);
    expect(step(planJob, "Encrypt plan").run).toContain(
      "openssl enc -aes-256-cbc",
    );
  });

  test("the summary step writes only the redacted plan summary", () => {
    const summary = step(planJob, "Summarize changes").run;
    const writes = summary
      .split("\n")
      .filter((line) => line.includes("GITHUB_STEP_SUMMARY"));
    expect(writes).toEqual([
      'node scripts/deployment/terraform-runs.cjs plan-summary "$RUNNER_TEMP/plan.json" "$GITHUB_SHA" "$PLAN_SHA256" >> "$GITHUB_STEP_SUMMARY"',
    ]);
    expect(summary).toContain('rm "$RUNNER_TEMP/plan.json"');
    expect(scripts(planJob)).toContain("-out=tfplan > /dev/null");
  });

  test("apply checks the plan run and production idleness before it decrypts", () => {
    const names = applyJob.steps.map((s) => s.name);
    const verify = names.indexOf(
      "Verify the plan run is a successful plan of this commit",
    );
    const idle = names.indexOf("Refuse while a production deploy is open");
    const download = names.indexOf("Download encrypted plan");
    expect(applyJob.steps[verify].run).toBe(
      'node scripts/deployment/terraform-runs.cjs verify-plan-run "$ENVIRONMENT" "$PLAN_RUN_ID"',
    );
    expect(applyJob.steps[idle].run).toBe(
      "node scripts/deployment/terraform-runs.cjs assert-production-idle",
    );
    expect(verify).toBeLessThan(download);
    expect(idle).toBeLessThan(download);
    expect(step(applyJob, "Download encrypted plan").with["run-id"]).toBe(
      "${{ inputs.plan_run_id }}",
    );
  });

  test("apply applies the saved plan and has only the two inputs", () => {
    expect(step(applyJob, "Apply the saved plan").run).toContain(
      "apply -input=false -lock-timeout=5m tfplan",
    );
    expect(Object.keys(applyWorkflow.on.workflow_dispatch.inputs)).toEqual([
      "environment",
      "plan_run_id",
    ]);
    expect(applyWorkflow.concurrency.group).toBe(
      "chronote-terraform-${{ inputs.environment }}",
    );
  });
});

describe("Terraform role trust and sessions", () => {
  const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const workflowName = (file) => parse(read(`.github/workflows/${file}`)).name;
  const role = read("_infra/production-bootstrap/terraform-role.tf");

  test("only the Plan and Apply workflows may assume the Terraform role", () => {
    const claim = role.match(
      /"token\.actions\.githubusercontent\.com:workflow"\s*=\s*\[([^\]]*)\]/,
    )?.[1];
    expect(claim).toBeDefined();
    expect([...claim.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([
      workflowName("terraform-apply.yml"),
      workflowName("terraform-plan.yml"),
    ]);
  });

  test("the Plan session is read-only apart from the state lock", () => {
    const credentials = parse(
      read(".github/workflows/terraform-plan.yml"),
    ).jobs.plan.steps.find((s) => s.name === "Configure AWS credentials").with;
    expect(credentials["managed-session-policies"]).toBe(
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    );
    const inline = JSON.parse(credentials["inline-session-policy"]);
    const actions = inline.Statement.flatMap((s) => [s.Action].flat());
    expect(actions.sort()).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "kms:Decrypt",
      "secretsmanager:GetSecretValue",
    ]);
    const lock = inline.Statement.find((s) =>
      [s.Action].flat().includes("dynamodb:PutItem"),
    );
    expect(lock.Resource).toBe(
      "arn:aws:dynamodb:*:*:table/meeting-notes-terraform-state-locks",
    );
  });

  test("the Apply session is the full role", () => {
    const credentials = parse(
      read(".github/workflows/terraform-apply.yml"),
    ).jobs.apply.steps.find((s) => s.name === "Configure AWS credentials").with;
    expect(credentials["managed-session-policies"]).toBeUndefined();
    expect(credentials["inline-session-policy"]).toBeUndefined();
  });
});
