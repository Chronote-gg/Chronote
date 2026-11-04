/** @jest-environment node */
import {
  decideDesktopCheck,
  exitCodeForDecision,
} from "../../scripts/desktop-check";

test("runs the desktop Rust tests on Windows regardless of the environment", () => {
  expect(decideDesktopCheck("win32", {})).toBe("run");
  expect(decideDesktopCheck("win32", { GITHUB_ACTIONS: "true" })).toBe("run");
});

// A devcontainer or agent sandbox sets CI and legitimately runs `yarn check:ci`
// on Linux, so CI alone must not turn a convenience skip into a hard failure.
test("skips off Windows locally, including when CI is set", () => {
  expect(decideDesktopCheck("linux", {})).toBe("skip");
  expect(decideDesktopCheck("darwin", {})).toBe("skip");
  expect(decideDesktopCheck("linux", { CI: "true" })).toBe("skip");
});

// An Actions job that skips here reports green while running no desktop test at
// all, which is the regression the cargo test change was made to fix. Moving
// Desktop Check to a cheaper Linux runner has to fail loudly, not quietly.
test("refuses off Windows on an Actions runner", () => {
  expect(decideDesktopCheck("linux", { GITHUB_ACTIONS: "true" })).toBe(
    "refuse",
  );
  expect(decideDesktopCheck("darwin", { GITHUB_ACTIONS: "true" })).toBe(
    "refuse",
  );
});

// Deciding to refuse is worthless if the process still exits 0, so pin the
// mapping separately from the decision.
test("refusing exits non-zero and skipping exits zero", () => {
  expect(exitCodeForDecision("refuse")).toBe(1);
  expect(exitCodeForDecision("skip")).toBe(0);
  expect(exitCodeForDecision("run")).toBe(0);
});
