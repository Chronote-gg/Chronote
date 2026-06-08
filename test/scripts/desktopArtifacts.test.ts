import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "desktop-artifacts.mjs");

function runArtifactsScript(artifactDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DESKTOP_ARTIFACT_DIR: artifactDir,
    },
    encoding: "utf8",
  });
}

describe("desktop artifact validation", () => {
  let artifactDir: string;

  beforeEach(() => {
    artifactDir = mkdtempSync(
      path.join(tmpdir(), "chronote-desktop-artifacts-"),
    );
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  test("accepts versioned Chronote desktop installers and writes checksums", () => {
    const msi = path.join(artifactDir, "Chronote Desktop_0.1.0_x64_en-US.msi");
    const setup = path.join(
      artifactDir,
      "Chronote Desktop_0.1.0_x64-setup.exe",
    );
    writeFileSync(msi, "fake msi");
    writeFileSync(setup, "fake setup");

    const result = runArtifactsScript(artifactDir, ["--write"]);
    const checksumPath = path.join(artifactDir, "SHA256SUMS.txt");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Desktop artifacts validated");
    expect(existsSync(checksumPath)).toBe(true);
    expect(readFileSync(checksumPath, "utf8")).toContain(path.basename(msi));
    expect(readFileSync(checksumPath, "utf8")).toContain(path.basename(setup));
  });

  test("rejects artifacts that do not include the expected product and version", () => {
    writeFileSync(path.join(artifactDir, "OtherApp_1.0.0_x64.msi"), "fake msi");

    const result = runArtifactsScript(artifactDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Desktop artifacts do not include expected product/version",
    );
  });
});
