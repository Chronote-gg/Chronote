/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Windows runners bill at twice the Linux rate and were 80% of the October 2026
// Blacksmith spend, so the Windows jobs skip while a pull request is a draft.
// That saving is only safe because marking the PR ready runs them again. Drop
// ready_for_review from either trigger list and the jobs stop running on
// mark-ready forever, silently, with every gate still green. These assertions
// exist so that deletion fails here instead of in the invoice.

const workflow = (path: string) =>
  parse(readFileSync(`.github/workflows/${path}`, "utf8"));

const WINDOWS_RUNNER = "blacksmith-4vcpu-windows-2025";
const REQUIRED_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
];

test.each(["ci.yml", "desktop-package.yml"])(
  "%s keeps ready_for_review alongside the default pull_request types",
  (file) => {
    const types: string[] = workflow(file).on.pull_request.types;
    // Listing types at all drops the defaults, so the original three have to
    // stay listed next to the new one.
    for (const required of REQUIRED_TYPES) {
      expect(types).toContain(required);
    }
  },
);

// Both jobs skip on a draft, so this run is free and exists only to join the
// concurrency group and cancel a bundle that is still building.
test("desktop-package.yml treats converting back to draft as a cancellation", () => {
  expect(workflow("desktop-package.yml").on.pull_request.types).toContain(
    "converted_to_draft",
  );
});

test("every Windows job in desktop-package.yml is gated on the PR not being a draft", () => {
  const jobs = Object.entries(
    workflow("desktop-package.yml").jobs as Record<
      string,
      { "runs-on": string; if?: string }
    >,
  );
  const windowsJobs = jobs.filter(
    ([, job]) => job["runs-on"] === WINDOWS_RUNNER,
  );
  expect(windowsJobs.length).toBeGreaterThan(0);
  for (const [name, job] of windowsJobs) {
    expect(`${name}: ${job.if ?? ""}`).toContain(
      "github.event.pull_request.draft == false",
    );
  }
});

test("ci.yml gates Visual Regression and the Desktop Check input on the draft flag", () => {
  const ci = workflow("ci.yml");
  expect(ci.jobs["visual-regression"]["runs-on"]).toBe("windows-2025");
  expect(ci.jobs["visual-regression"].if).toContain(
    "github.event.pull_request.draft == false",
  );
  // Desktop Check lives in the reusable workflow, so ci.yml gates it through
  // the input rather than through an `if` of its own.
  expect(ci.jobs["core-ci"].with.run_desktop).toContain(
    "github.event.pull_request.draft == false",
  );
});

test("desktop-package.yml cancels a superseded pull request run but never a master one", () => {
  const { concurrency } = workflow("desktop-package.yml");
  expect(concurrency.group).toContain("github.event.pull_request.number");
  // Cancelling unconditionally would let a second merge landing quickly kill
  // the first one's run, and that run is the only post-merge validation the
  // packaged artifact gets.
  expect(concurrency["cancel-in-progress"]).toContain(
    "github.event_name == 'pull_request'",
  );
});
