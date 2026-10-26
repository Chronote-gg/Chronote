/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { assertAcceptanceJobs } from "../../scripts/deployment/production-acceptance-package.cjs";

const source = "a".repeat(40);
function jobs(repair = false) {
  const job = (name, start, end, conclusion = "success") => ({
    name,
    head_sha: source,
    started_at: start === null ? null : new Date(start * 1000).toISOString(),
    completed_at: end === null ? null : new Date(end * 1000).toISOString(),
    status: end === null ? "in_progress" : "completed",
    conclusion,
  });
  return {
    total_count: 6,
    jobs: [
      job("Introduce production", 100, 110, repair ? "failure" : "success"),
      job(
        "Approve failed-unserved continuation",
        111,
        112,
        repair ? "success" : "skipped",
      ),
      job(
        "Continue failed-unserved introduction",
        113,
        120,
        repair ? "success" : "skipped",
      ),
      job("Prepare production acceptance", 121, 130),
      job("Approve production acceptance", 131, 140),
      job("Accept production introduction", 141, null, null),
    ],
  };
}
test.each([false, true])(
  "acceptance follows the unique original completed path, repair=%s",
  (repair) => {
    expect(
      assertAcceptanceJobs(jobs(repair), source, "accept", 150, {
        validFrom: 100,
        validUntil: 200,
      }),
    ).toEqual({ prepareCompletedAt: 130, gateCompletedAt: 140 });
  },
);
test.each([
  "duplicate",
  "stale",
  "incomplete",
  "missing",
  "skipped",
  "gate-before-pin",
  "accept-before-gate",
  "clock",
  "expired",
  "wrong-path",
  "future",
])("acceptance refuses %s job evidence", (reason) => {
  const j = jobs();
  let now = 150;
  if (reason === "duplicate") {
    j.jobs.push(j.jobs[4]);
    j.total_count++;
  }
  if (reason === "stale") j.jobs[4].head_sha = "b".repeat(40);
  if (reason === "incomplete") j.total_count++;
  if (reason === "missing") {
    j.jobs.splice(4, 1);
    j.total_count--;
  }
  if (reason === "skipped") j.jobs[4].conclusion = "skipped";
  if (reason === "gate-before-pin")
    j.jobs[4].started_at = new Date(129000).toISOString();
  if (reason === "accept-before-gate")
    j.jobs[5].started_at = new Date(139000).toISOString();
  if (reason === "clock") j.jobs[3].completed_at = "invalid";
  if (reason === "expired") now = 200;
  if (reason === "wrong-path") j.jobs[2].conclusion = "success";
  if (reason === "future")
    j.jobs[4].completed_at = new Date(160000).toISOString();
  expect(() =>
    assertAcceptanceJobs(j, source, "accept", now, {
      validFrom: 100,
      validUntil: 200,
    }),
  ).toThrow();
});
test("preparation requires its current unique job and cannot consume a completed gate", () => {
  const j = jobs();
  j.jobs = j.jobs.slice(0, 4);
  j.total_count = 4;
  Object.assign(j.jobs[3], {
    completed_at: null,
    conclusion: null,
    status: "in_progress",
  });
  expect(
    assertAcceptanceJobs(j, source, "prepare-acceptance", 125, {
      validFrom: 100,
      validUntil: 200,
    }),
  ).toEqual({});
  j.jobs.push(jobs().jobs[4]);
  j.total_count++;
  expect(() =>
    assertAcceptanceJobs(j, source, "prepare-acceptance", 150, {
      validFrom: 100,
      validUntil: 200,
    }),
  ).toThrow();
});
