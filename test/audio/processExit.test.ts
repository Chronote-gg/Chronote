/** @jest-environment node */
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("voice teardown process survival", () => {
  test.each(["timer-receiver", "timer-decoder", "handled-decoder"])(
    "contains %s through the production callback boundary",
    (fault) => {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "fixtures/voiceCaptureExit.cjs"), fault],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("callbackFailureHandled=true\n");
      expect(result.stderr).toBe("");
    },
  );

  test.each([
    ["graceful-startup", 0],
    ["fatal-startup", 1],
  ])("preserves the %s exit comparison", (fault, status) => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "fixtures/voiceCaptureExit.cjs"), String(fault)],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(status);
    if (status === 1)
      expect(result.stderr).toContain("synthetic startup failure");
  });
  test.each(["pending-opus", "pending-decoder"])(
    "survives %s through the production subscription cleanup",
    (fault) => {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "fixtures/voiceCaptureExit.cjs"), fault],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("teardownCompleted=true\n");
      expect(result.stderr).toBe("");
    },
  );
});
