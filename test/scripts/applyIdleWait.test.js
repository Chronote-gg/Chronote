/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { waitForApplyIdle } from "../../scripts/deployment/terraform-native.cjs";

const repository = "Chronote-gg/Chronote";
const runsPath = `/repos/${repository}/actions/workflows/terraform-apply.yml/runs?status=in_progress&per_page=100`;
const applyRun = (environment) => ({
  display_title: `Terraform Apply ${environment}/default/deployment-runtime plan=1 plan-sha=a bundle-sha=b`,
});
const page = (...titles) => ({
  total_count: titles.length,
  workflow_runs: titles.map(applyRun),
});

// Replays one response (or thrown error) per poll and records the clock.
function harness(responses) {
  const calls = [];
  let clock = 0;
  const get = async (path, options) => {
    calls.push({ path, options });
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
  expect(h.calls).toEqual([{ path: runsPath, options: { paginated: true } }]);
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
  const h = harness([
    new Error("UNKNOWN: GitHub metadata unavailable"),
    page(),
  ]);
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
