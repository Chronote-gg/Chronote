/** @jest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";

const DEPLOY_SCRIPT = "node scripts/deployment/deploy.cjs";
const MINIMUM_BACKEND_TIMEOUT_MINUTES = 200;
const FILES = ["deploy.yml", "deploy-staging.yml"];
const ASSUME_ROLE = "aws-actions/configure-aws-credentials@";

const read = (name) => readFileSync(`.github/workflows/${name}`, "utf8");
const runs = (job) => job.steps.map((step) => step.run ?? "");
const indexOfCommand = (job, command) =>
  runs(job).findIndex((run) => run.includes(`${DEPLOY_SCRIPT} ${command}`));
const roleAssumptions = (job) =>
  job.steps.flatMap((step, index) =>
    step.uses?.startsWith(ASSUME_ROLE) ? [index] : [],
  );

describe.each(FILES)("%s", (name) => {
  const workflow = parse(read(name));
  const backend = workflow.jobs.deploybackend;

  test("the backend holds a lock that is never cancelled and outlasts the drain", () => {
    expect(backend.concurrency.group).toBeTruthy();
    expect(backend.concurrency["cancel-in-progress"]).toBe(false);
    expect(backend["timeout-minutes"]).toBeGreaterThanOrEqual(
      MINIMUM_BACKEND_TIMEOUT_MINUTES,
    );
    expect(workflow.jobs["drain-wait"]).toBeUndefined();
  });

  test("the backend waits for the drain and assumes the role again before the rollout", () => {
    const drain = indexOfCommand(backend, "wait-drain");
    const rollout = indexOfCommand(backend, "rollout");
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(drain).toBeLessThan(rollout);
    const assumptions = roleAssumptions(backend);
    expect(assumptions.some((index) => index < drain)).toBe(true);
    expect(assumptions.some((index) => index > drain && index < rollout)).toBe(
      true,
    );
  });

  test("the backend runs preflight, rollout and wait-ready in order", () => {
    const order = ["preflight", "rollout", "wait-ready"].map((command) =>
      indexOfCommand(backend, command),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("rollback runs only when the rollout or the ready wait failed and a previous image is known", () => {
    const rollback = backend.steps[indexOfCommand(backend, "rollback")];
    expect(rollback).toBeDefined();
    expect(rollback.if).toMatch(/^failure\(\) && /);
    expect(rollback.if).toContain(
      "(steps.rollout.outcome == 'failure' || steps.wait-ready.outcome == 'failure')",
    );
    expect(rollback.if).toContain("steps.rollout.outputs.previous_image != ''");
  });

  test("wait-ready and rollback consume the rollout step's outputs", () => {
    const rollout = backend.steps[indexOfCommand(backend, "rollout")];
    const ready = backend.steps[indexOfCommand(backend, "wait-ready")];
    const rollback = backend.steps[indexOfCommand(backend, "rollback")];
    expect(rollout.id).toBe("rollout");
    expect(ready.id).toBe("wait-ready");
    expect(ready.env.RELEASE).toBe("${{ steps.rollout.outputs.revision }}");
    expect(ready.run).toContain('--release "$RELEASE"');
    expect(rollback.env.PREVIOUS_IMAGE).toBe(
      "${{ steps.rollout.outputs.previous_image }}",
    );
    expect(rollback.run).toContain('--image "$PREVIOUS_IMAGE"');
  });

  test("rollback is given only the previous image", () => {
    const rollback = backend.steps[indexOfCommand(backend, "rollback")];
    expect(Object.keys(rollback.env)).toEqual(["PREVIOUS_IMAGE"]);
    expect(rollback.run.trim()).toBe(
      `${DEPLOY_SCRIPT} rollback --image "$PREVIOUS_IMAGE"`,
    );
  });

  test("nothing references the removed coordinator, guard or break-glass", () => {
    expect(read(name)).not.toMatch(
      /coordinator\.cjs|production-writer-guard|break-glass/,
    );
  });
});

test("both workflows invoke the same deploy script", () => {
  for (const name of FILES) expect(read(name)).toContain(DEPLOY_SCRIPT);
  const scripts = FILES.map((name) =>
    [...read(name).matchAll(/node (scripts\/deployment\/deploy[^ ]*)/g)].map(
      (match) => match[1],
    ),
  );
  expect(new Set(scripts.flat())).toEqual(
    new Set(["scripts/deployment/deploy.cjs"]),
  );
});

test("both workflows roll back and capture rollout outputs identically", () => {
  const [production, staging] = FILES.map((name) => {
    const backend = parse(read(name)).jobs.deploybackend;
    return ["rollout", "rollback"].map(
      (command) => backend.steps[indexOfCommand(backend, command)],
    );
  });
  expect(staging).toEqual(production);
});
