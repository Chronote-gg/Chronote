/** @jest-environment node */
import process from "node:process";
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrivateCommand } from "../../scripts/deployment/terraform-process.cjs";
test.each([0, 1, 2])(
  "private child preserves both exact streams at exit %s",
  async (code) => {
    const directory = mkdtempSync(join(tmpdir(), "private-child-"));
    try {
      const script = join(directory, "fake.cjs");
      writeFileSync(
        script,
        `process.stdout.write(Buffer.from([0,255,13,10]));process.stderr.write('SECRET');process.exitCode=${code};`,
      );
      const record = await runPrivateCommand(process.execPath, [script], {
        directory,
        index: 0,
        cwd: directory,
        env: {},
        signal: new AbortController().signal,
      });
      expect(record.exitCode).toBe(code);
      expect(Buffer.from(record.stdout, "base64")).toEqual(
        Buffer.from([0, 255, 13, 10]),
      );
      expect(Buffer.from(record.stderr, "base64").toString()).toBe("SECRET");
      expect(readFileSync(join(directory, "0.stdout"))).toEqual(
        Buffer.from([0, 255, 13, 10]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test("cancellation waits for owned child close and keeps partial output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "private-cancel-")),
    controller = new AbortController();
  try {
    const script = join(directory, "fake.cjs");
    writeFileSync(
      script,
      "process.stdout.write('PRIVATE');setInterval(()=>{},1000);",
    );
    const timer = setTimeout(() => controller.abort(), 200);
    const record = await runPrivateCommand(process.execPath, [script], {
      directory,
      index: 0,
      cwd: directory,
      env: {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    expect(record.outcome).toBe("unknown");
    expect(record.exitCode).toBeNull();
    expect(Buffer.from(record.stdout, "base64").toString()).toBe("PRIVATE");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
