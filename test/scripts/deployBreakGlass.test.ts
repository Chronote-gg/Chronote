/** @jest-environment node */
import { readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";
import { parse } from "yaml";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string[];
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
};
const deployment = parse(
  readFileSync(".github/workflows/deploy.yml", "utf8"),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string }> } };
  jobs: Record<string, Job>;
};
const { jobs } = deployment;
const step = (job: Job, name: string) =>
  job.steps!.find((item) => item.name === name)!;

test("break-glass is a dispatch input with a reason and manifest hash", () => {
  const inputs = deployment.on.workflow_dispatch.inputs;
  expect(inputs.break_glass.type).toBe("boolean");
  expect(inputs.break_glass_reason.type).toBe("string");
  expect(inputs.backup_manifest_sha256.type).toBe("string");
});

// The two gates must be mutually exclusive so that a push can never reach the
// break-glass path and a break-glass run never waits on CI.
test("the gate runs only on a break-glass dispatch, and CI never alongside it", () => {
  const gate = "github.event_name == 'workflow_dispatch' && inputs.break_glass";
  expect(jobs["break-glass"].if).toBe(gate);
  expect(jobs.ci.if).toBe(`github.ref == 'refs/heads/master' && !(${gate})`);
});

test("the gate holds no production environment or AWS identity", () => {
  const job = jobs["break-glass"];
  expect(job.environment).toBeUndefined();
  expect(job.permissions).toEqual({
    contents: "read",
    checks: "read",
    "pull-requests": "read",
  });
  expect(
    step(job, "Verify dispatcher and merged pull request checks").run,
  ).toBe("node scripts/deployment/break-glass-guard.cjs");
});

test("the backend runs after CI and Docs, or after the gate alone", () => {
  const backend = jobs.deploybackend;
  expect(backend.needs).toEqual(["ci", "deploy-docs", "break-glass"]);
  const condition = backend.if!.replace(/\s+/g, " ");
  expect(condition).toContain(
    "(needs.ci.result == 'success' && needs.deploy-docs.result == 'success' && needs.break-glass.result == 'skipped')",
  );
  expect(condition).toContain(
    "(needs.break-glass.result == 'success' && needs.ci.result == 'skipped' && needs.deploy-docs.result == 'skipped')",
  );
  expect(backend.environment).toBe("production");
});

test("break-glass reaches the coordinator only from the gate's success", () => {
  const backend = jobs.deploybackend;
  expect(backend.env!.BREAK_GLASS).toBe(
    "${{ needs.break-glass.result == 'success' && '1' || '' }}",
  );
  const prepare = step(backend, "Protect serving runtime and warm candidate");
  expect(prepare.env!.HANDOFF_QUIET_OVERRIDE).toContain(
    "env.BREAK_GLASS == '1'",
  );
  expect(prepare.env!.BREAK_GLASS_RECORD_PATH).toBe(
    step(backend, "Create deployment summary").env!.BREAK_GLASS_RECORD_PATH,
  );
});

test("jobs after the backend run on its success under either gate", () => {
  for (const id of [
    "deploy-frontend",
    "promote-prompts",
    "sync-openai-connection",
  ])
    expect(jobs[id].if).toBe(
      "${{ !cancelled() && needs.deploybackend.result == 'success' }}",
    );
});
