/** @jest-environment node */
import { spawnSync } from "node:child_process";
import path from "node:path";

test("operator listening batch verifies exact PCM, scope, privacy and unavailable evidence", () => {
  const root = path.resolve(__dirname, "../..");
  const result = spawnSync(
    process.execPath,
    ["--test", "scripts/speech-detection/listening-batch.test.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  expect({
    status: result.status,
    error: result.error,
    output: result.status ? result.stdout + result.stderr : undefined,
  }).toEqual({ status: 0, error: undefined, output: undefined });
}, 20000);
