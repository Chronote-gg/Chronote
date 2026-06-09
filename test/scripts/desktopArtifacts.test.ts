import {
  existsSync,
  mkdirSync,
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
const fixtureVersion = "0.1.0";

function runArtifactsScript(artifactDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DESKTOP_ARTIFACT_DIR: artifactDir,
      DESKTOP_ARTIFACT_VERSION: fixtureVersion,
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
    const msi = path.join(
      artifactDir,
      `Chronote Desktop_${fixtureVersion}_x64_en-US.msi`,
    );
    const setup = path.join(
      artifactDir,
      `Chronote Desktop_${fixtureVersion}_x64-setup.exe`,
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

  test("can write release checksums with asset basenames", () => {
    const msiDir = path.join(artifactDir, "msi");
    const nsisDir = path.join(artifactDir, "nsis");
    mkdirSync(msiDir);
    mkdirSync(nsisDir);
    const msi = path.join(
      msiDir,
      `Chronote Desktop_${fixtureVersion}_x64_en-US.msi`,
    );
    const setup = path.join(
      nsisDir,
      `Chronote Desktop_${fixtureVersion}_x64-setup.exe`,
    );
    writeFileSync(msi, "fake msi");
    writeFileSync(setup, "fake setup");

    const result = runArtifactsScript(artifactDir, [
      "--write",
      "--checksum-paths=basename",
    ]);
    const checksumText = readFileSync(
      path.join(artifactDir, "SHA256SUMS.txt"),
      "utf8",
    );

    expect(result.status).toBe(0);
    expect(checksumText).toContain(`  ${path.basename(msi)}`);
    expect(checksumText).toContain(`  ${path.basename(setup)}`);
    expect(checksumText).not.toContain("msi/");
    expect(checksumText).not.toContain("nsis/");
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
