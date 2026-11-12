/** @jest-environment node */
import { readFileSync } from "node:fs";
import { test, expect } from "@jest/globals";
import { parse } from "yaml";

// Production deploy concurrency is per job, not per workflow, so that a rapid
// second merge cancels stale CI without ever cancelling a deploy that has
// started. These assertions pin the properties that safety rests on, because
// every one of them fails silently rather than loudly if it regresses.

type Job = {
  needs?: string | string[];
  concurrency?: { group: string; "cancel-in-progress": boolean | string };
};

const deployment = parse(
  readFileSync(".github/workflows/deploy.yml", "utf8"),
) as { concurrency?: unknown; jobs: Record<string, Job> };

const CI_JOB = "ci";
const deployJobs = Object.entries(deployment.jobs).filter(
  ([id]) => id !== CI_JOB,
);

// A workflow-level group holds a newer run entirely pending, so its CI never
// starts and cannot supersede the stale CI from the previous push. Restoring
// one would silently undo the whole change.
test("deploy.yml has no workflow-level concurrency group", () => {
  expect(deployment.concurrency).toBeUndefined();
});

// One group across both events, so at most one master CI is alive and the
// newest run wins. Scoping the group by event instead would let a dispatch of
// an older commit finish CI late and publish over a newer push, rolling the
// backend, frontend and promoted prompts back, so the group must not vary.
test("CI is cancellable and shares one group across every event", () => {
  const ci = deployment.jobs[CI_JOB].concurrency;
  expect(ci?.group).toBe("chronote-master-ci");
  expect(ci?.group).not.toContain("github.event_name");
  expect(ci?.["cancel-in-progress"]).toBe(true);
});

test("no deploy job can be cancelled once it starts", () => {
  expect(deployJobs.length).toBeGreaterThan(0);
  for (const [id, job] of deployJobs) {
    expect(`${id}: ${JSON.stringify(job.concurrency)}`).toContain(
      '"cancel-in-progress":false',
    );
  }
});

// GitHub keeps at most one pending entry per concurrency group and a newer
// pending entry cancels the older one rather than queueing behind it. Two
// deploy jobs sharing a group would therefore drop one of them silently, and
// deploy-frontend, promote-prompts and sync-openai-connection all become ready
// the moment deploybackend succeeds.
test("every deploy job has a group of its own", () => {
  const groups = deployJobs.map(([, job]) => job.concurrency?.group);
  expect(new Set(groups).size).toBe(groups.length);
  for (const group of groups) expect(group).toBeTruthy();
});

// The backend holds the drain wait and the rollout under one lock, so no run
// can roll out while another run's older task is still draining.
test("the backend deploy holds the production rollout lock", () => {
  expect(deployment.jobs.deploybackend.concurrency?.group).toBe(
    "backend-rollout-production",
  );
});

// This is what makes cancelling CI safe: a cancelled job skips everything
// downstream of it, so no deploy job can begin on a run whose CI was killed.
test("every deploy job depends on CI, directly or transitively", () => {
  const needsOf = (id: string): string[] => {
    const needs = deployment.jobs[id]?.needs;
    if (!needs) return [];
    return Array.isArray(needs) ? needs : [needs];
  };
  const reachesCi = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const needs = needsOf(id);
    return needs.includes(CI_JOB) || needs.some((n) => reachesCi(n, seen));
  };
  for (const [id] of deployJobs) {
    expect(`${id} reaches ci: ${reachesCi(id)}`).toBe(`${id} reaches ci: true`);
  }
});
