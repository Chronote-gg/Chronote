import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  requireDeploymentTestImage,
  writeDeploymentFixtureReceipt,
} from "./containerFixture";
import type { MeetingHistory } from "../../src/types/db";
import type {
  CheckpointObject,
  RecordingManifest,
} from "../../src/types/recordingCheckpoint";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
const image = requireDeploymentTestImage();
const fixture = path.resolve("test/deployment/fixtures/nativeShutdown.cjs");
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
function entrypoint(mode: "all" | "bot" | "api" | "fault") {
  return ["all", "fault"].includes(mode)
    ? []
    : ["node", `dist/apps/${mode}/main.js`];
}
function json<T>(directory: string, file: string): T {
  return JSON.parse(readFileSync(path.join(directory, file), "utf8")) as T;
}
function verifiedObject(
  directory: string,
  reference: CheckpointObject,
): Buffer {
  const name = createHash("sha256").update(reference.key).digest("hex");
  const bytes = readFileSync(path.join(directory, "objects", name));
  expect(bytes.length).toBe(reference.byteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    reference.checksumSha256,
  );
  return bytes;
}
function audioBytes(directory: string, history: MeetingHistory): number {
  expect(history.checkpoint).toBeDefined();
  const manifest = JSON.parse(
    verifiedObject(directory, history.checkpoint!.manifest).toString(),
  ) as RecordingManifest;
  return manifest.artifacts.reduce((total, artifact) => {
    const bytes = verifiedObject(directory, artifact.object);
    return total + (artifact.kind === "audio" ? bytes.length : 0);
  }, 0);
}
async function ready(container: string, directory: string) {
  const deadline = Date.now() + 95000;
  while (!existsSync(path.join(directory, "ready.json"))) {
    if (
      docker("inspect", "--format", "{{.State.Running}}", container) !== "true"
    )
      throw new Error(docker("logs", container));
    if (Date.now() >= deadline)
      throw new Error(
        `Fixture readiness timeout: ${docker("logs", container)}`,
      );
    await pause();
  }
}
function removeFixtureDirectory(directory: string) {
  const resolved = realpathSync(directory);
  const root = realpathSync(tmpdir());
  if (
    !resolved.startsWith(root + path.sep) ||
    !path.basename(resolved).startsWith("chronote-r3-native-")
  )
    throw new Error("Fixture cleanup target escaped temporary root");
  rmSync(resolved, { recursive: true, force: true });
}
function assertOwned(container: string, owner: string) {
  expect(
    docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "chronote.r3.fixture"}}',
      container,
    ),
  ).toBe(owner);
}
test.each(["all", "bot", "api", "fault"] as const)(
  "native %s entrypoint retains truthful checkpoints and owned shutdown",
  async (mode) => {
    for (const signal of mode === "fault"
      ? (["SIGTERM"] as const)
      : (["SIGTERM", "SIGKILL"] as const)) {
      const owner = randomUUID();
      const directory = mkdtempSync(path.join(tmpdir(), "chronote-r3-native-"));
      let container: string | undefined;
      try {
        container = docker(
          "run",
          "--detach",
          ...(process.platform === "linux"
            ? ["--user", `${process.getuid!()}:${process.getgid!()}`]
            : []),
          "--network",
          "none",
          "--label",
          `chronote.r3.fixture=${owner}`,
          "--mount",
          `type=bind,source=${directory},target=/fixture-output`,
          "--mount",
          `type=bind,source=${fixture},target=/app/nativeShutdown.cjs,readonly`,
          "--mount",
          `type=bind,source=${path.resolve("test/deployment/fixtures/nativeRecoveryFaults.cjs")},target=/app/nativeRecoveryFaults.cjs,readonly`,
          "--env",
          `RECORDING_FAULT_FIXTURE=${mode === "fault"}`,
          "--env",
          "NODE_OPTIONS=--require=/app/nativeShutdown.cjs",
          image,
          ...entrypoint(mode),
        );
        await ready(container, directory);
        if (process.platform === "linux") {
          expect(statSync(path.join(directory, "ready.json")).uid).toBe(
            process.getuid!(),
          );
          expect(statSync(path.join(directory, "ready.json")).gid).toBe(
            process.getgid!(),
          );
        }
        const readiness = json<{
          pid: number;
          node: string;
          mode: string;
          counts: Record<string, number>;
        }>(directory, "ready.json");
        expect(readiness).toMatchObject({
          pid: 1,
          node: "v24.15.0",
          mode: mode === "fault" ? "all" : mode,
        });
        if (mode === "fault") {
          const faults = json<{
            closureMs: number;
            cutoffMs: number;
            tempBytes: number;
            sourceBytes: number;
            reservedAtCutoff: number;
            limitBytes: number;
            rssBytes: number;
          }>(directory, "faults.json");
          expect(faults).toMatchObject({
            reason: "storage_preservation",
            attempts: 1,
            sourceCount: 4,
            earlyReleaseRefused: true,
            intakeAfterCutoff: false,
            reservedAfterSettlement: 0,
          });
          expect(faults.closureMs).toBeGreaterThanOrEqual(29900);
          expect(faults.closureMs).toBeLessThan(35000);
          expect(faults.cutoffMs).toBeGreaterThanOrEqual(59900);
          expect(faults.cutoffMs).toBeLessThan(65000);
          expect(faults.tempBytes).toBe(faults.sourceBytes * 4);
          expect(faults.reservedAtCutoff).toBe(faults.tempBytes * 4);
          expect(faults.limitBytes).toBe(64 * 1024 * 1024);
          writeDeploymentFixtureReceipt("native-recovery-faults", {
            image,
            ...faults,
          });
          console.log(`Native fault measurements: ${JSON.stringify(faults)}`);
        }
        expect(readiness.counts.ancillary_delivery).toBeGreaterThan(0);
        const before =
          mode === "api"
            ? undefined
            : json<MeetingHistory>(directory, "before.json");
        if (before) expect(audioBytes(directory, before)).toBe(48000 * 4 * 30);
        assertOwned(container, owner);
        const started = performance.now();
        docker("kill", "--signal", signal, container);
        const code = docker("wait", container);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(120000);
        if (signal === "SIGTERM") {
          if (code !== "0")
            throw new Error(
              `Native exit ${code}: ${docker("logs", container)}`,
            );
          const exited = json<{
            apiSettled: boolean;
            captureFinished: boolean;
            encodedBytes: number;
            counts: Record<string, number>;
          }>(directory, "exit.json");
          expect(exited.apiSettled).toBe(true);
          expect(
            Object.values(exited.counts).every((count) => count === 0),
          ).toBe(true);
          if (before) {
            expect(exited.captureFinished).toBe(true);
            expect(exited.encodedBytes).toBeGreaterThan(0);
            const after = json<MeetingHistory>(directory, "history.json");
            expect(after.status).toBe("interrupted");
            expect(after.recovery?.disposition).toBe("pending");
            expect(audioBytes(directory, after)).toBe(48000 * 4 * 30.2);
          }
        } else {
          expect(code).toBe("137");
          expect(existsSync(path.join(directory, "exit.json"))).toBe(false);
          if (before) {
            const after = json<MeetingHistory>(directory, "history.json");
            expect(after.checkpoint).toEqual(before.checkpoint);
            expect(after.capture?.kind).not.toBe("complete");
            expect(audioBytes(directory, after)).toBe(48000 * 4 * 30);
          }
        }
        console.log(
          `Native fixture ${mode} ${signal}: exit=${code}, elapsedMs=${Math.round(elapsed)}, image=${image}`,
        );
      } finally {
        if (container) {
          assertOwned(container, owner);
          docker("rm", "--force", container);
        }
        removeFixtureDirectory(directory);
        expect(existsSync(directory)).toBe(false);
      }
    }
  },
);
