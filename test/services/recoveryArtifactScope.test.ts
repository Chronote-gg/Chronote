import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import * as tempFiles from "../../src/services/tempFileService";
import { createRecoveryArtifactScope } from "../../src/services/recoveryArtifactScope";

let base: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-scope-test-"));
  jest.spyOn(tempFiles, "ensureTempBaseDir").mockResolvedValue(base);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

test("a scope is a private directory under the recovery root that closing removes", async () => {
  const scope = await createRecoveryArtifactScope("synthetic-meeting");
  expect(path.dirname(scope.directory)).toBe(path.join(base, "r"));
  await fs.writeFile(path.join(scope.directory, "track.pcm"), "synthetic");

  await scope.close();

  await expect(fs.stat(scope.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("two scopes for one meeting do not share a directory", async () => {
  const first = await createRecoveryArtifactScope("synthetic-meeting");
  const second = await createRecoveryArtifactScope("synthetic-meeting");
  expect(first.directory).not.toBe(second.directory);
});

test("a failed removal is logged and does not throw", async () => {
  const scope = await createRecoveryArtifactScope("synthetic-meeting");
  jest.spyOn(fs, "rm").mockRejectedValueOnce(new Error("synthetic failure"));
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  await expect(scope.close()).resolves.toBeUndefined();

  expect(warn).toHaveBeenCalledTimes(1);
});
