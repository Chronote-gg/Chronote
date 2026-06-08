import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const defaultBundleRoot = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
);
const args = new Set(process.argv.slice(2));
const bundleRoot = path.resolve(
  process.env.DESKTOP_ARTIFACT_DIR || defaultBundleRoot,
);
const shouldWriteChecksums = args.has("--write");
const checksumPathMode =
  args.has("--checksum-paths=basename") ||
  process.env.DESKTOP_ARTIFACT_CHECKSUM_PATHS === "basename"
    ? "basename"
    : "relative";
const expectedVersion = await readExpectedVersion();
const expectedProductName = "chronote";
const releaseExtensions = new Set([".exe", ".msi"]);
const metadataExtensions = new Set([".json", ".sig"]);

async function readExpectedVersion() {
  if (process.env.DESKTOP_ARTIFACT_VERSION) {
    return process.env.DESKTOP_ARTIFACT_VERSION;
  }
  const configPath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "tauri.conf.json",
  );
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (typeof config.version !== "string" || config.version.length === 0) {
    throw new Error(`Desktop version is missing from ${configPath}.`);
  }
  return config.version;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function relativeArtifactPath(filePath) {
  return path.relative(bundleRoot, filePath).replaceAll(path.sep, "/");
}

function checksumArtifactPath(filePath) {
  if (checksumPathMode === "basename") {
    return path.basename(filePath);
  }
  return relativeArtifactPath(filePath);
}

if (!(await pathExists(bundleRoot))) {
  throw new Error(`Desktop artifact directory does not exist: ${bundleRoot}`);
}

const files = await listFiles(bundleRoot);
const releaseArtifacts = files.filter((filePath) =>
  releaseExtensions.has(path.extname(filePath).toLowerCase()),
);
const metadataArtifacts = files.filter((filePath) =>
  metadataExtensions.has(path.extname(filePath).toLowerCase()),
);

if (releaseArtifacts.length === 0) {
  throw new Error(
    `No Windows desktop release artifacts found under ${bundleRoot}. Expected .exe or .msi files.`,
  );
}

const invalidNames = releaseArtifacts.filter((filePath) => {
  const name = path.basename(filePath).toLowerCase();
  return !name.includes(expectedProductName) || !name.includes(expectedVersion);
});

if (invalidNames.length > 0) {
  throw new Error(
    `Desktop artifacts do not include expected product/version (${expectedProductName} ${expectedVersion}): ${invalidNames
      .map(relativeArtifactPath)
      .join(", ")}`,
  );
}

const checksumLines = [];
for (const artifact of [...releaseArtifacts, ...metadataArtifacts].sort()) {
  checksumLines.push(
    `${await sha256(artifact)}  ${checksumArtifactPath(artifact)}`,
  );
}

if (shouldWriteChecksums) {
  await fs.writeFile(
    path.join(bundleRoot, "SHA256SUMS.txt"),
    `${checksumLines.join("\n")}\n`,
  );
}

console.log("Desktop artifacts validated:");
for (const artifact of releaseArtifacts) {
  console.log(`  ${relativeArtifactPath(artifact)}`);
}
if (metadataArtifacts.length > 0) {
  console.log("Desktop metadata artifacts:");
  for (const artifact of metadataArtifacts) {
    console.log(`  ${relativeArtifactPath(artifact)}`);
  }
}
