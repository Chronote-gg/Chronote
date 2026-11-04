/** @jest-environment node */
import { decideDesktopCheck } from "../../scripts/desktop-check";

test("runs the desktop Rust tests on Windows regardless of CI", () => {
  expect(decideDesktopCheck("win32", {})).toBe("run");
  expect(decideDesktopCheck("win32", { CI: "true" })).toBe("run");
});

test("skips off Windows locally so a non-Windows working copy still works", () => {
  expect(decideDesktopCheck("linux", {})).toBe("skip");
  expect(decideDesktopCheck("darwin", {})).toBe("skip");
});

// A CI job that skips here reports green while running no desktop test at all,
// which is the regression the cargo test change was made to fix. Moving the
// Desktop Check job to a cheaper Linux runner has to fail loudly, not quietly.
test("refuses off Windows in CI instead of reporting a green no-op", () => {
  expect(decideDesktopCheck("linux", { CI: "true" })).toBe("refuse");
  expect(decideDesktopCheck("darwin", { CI: "1" })).toBe("refuse");
});
