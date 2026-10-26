/** @jest-environment node */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { expect, test } from "@jest/globals";

test.each(["cjs", "esm"])(
  "%s counts native reset readiness once and reports censored pending episodes",
  (distribution) => {
    const result = spawnSync(
      process.execPath,
      ["test/audio/fixtures/daveResetReadiness.mjs", distribution],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("resetReadinessVerified=true\n");
  },
);
