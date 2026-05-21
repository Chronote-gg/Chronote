const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const resultsIndex = args.indexOf("--results");
const outputIndex = args.indexOf("--output");
const runUrlIndex = args.indexOf("--run-url");
const snapshotChangesPathIndex = args.indexOf("--snapshot-changes");

const resultsDir =
  resultsIndex >= 0 && args[resultsIndex + 1]
    ? args[resultsIndex + 1]
    : "test-results";
const outputPath =
  outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : null;
const runUrl =
  runUrlIndex >= 0 && args[runUrlIndex + 1] ? args[runUrlIndex + 1] : "";
const snapshotChangesPath =
  snapshotChangesPathIndex >= 0 && args[snapshotChangesPathIndex + 1]
    ? args[snapshotChangesPathIndex + 1]
    : "";

const diffFiles = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      return;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith("-diff.png") || entry.name.endsWith("-diff.jpg"))
    ) {
      diffFiles.push(fullPath);
    }
  });
}

const parseNameStatusLine = (line) => {
  const tabParts = line.split("\t");
  const [status, ...fileParts] =
    tabParts.length > 1 ? tabParts : line.split(/\s+/);
  if (/^[RC]\d+/.test(status) && fileParts.length >= 2) {
    return `${status}: ${fileParts[0]} -> ${fileParts.slice(1).join(" ")}`;
  }
  return `${status}: ${fileParts.join(" ")}`;
};

walk(resultsDir);

const snapshotChanges =
  snapshotChangesPath && fs.existsSync(snapshotChangesPath)
    ? fs
        .readFileSync(snapshotChangesPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseNameStatusLine)
    : [];

const names = diffFiles
  .map((filePath) => path.basename(filePath).replace(/-diff\.(png|jpg)$/, ""))
  .sort((a, b) => a.localeCompare(b));

const lines = [];
lines.push("## Visual regression report");
if (snapshotChanges.length > 0) {
  lines.push(
    `Committed baseline snapshot updates in this PR: ${snapshotChanges.length}.`,
  );
  lines.push("");
  lines.push("Committed snapshot files:");
  snapshotChanges.forEach((change) => lines.push(`- ${change}`));
  lines.push("");
}
if (names.length === 0) {
  lines.push("No visual diffs detected.");
} else {
  lines.push(`Detected ${names.length} screenshot changes.`);
  lines.push("");
  lines.push("Changed snapshots:");
  names.forEach((name) => lines.push(`- ${name}`));
  lines.push("");
  lines.push(
    "Download the `visual-regression` artifact and open `playwright-report/index.html` for before and after images plus diffs.",
  );
}
if (runUrl) {
  lines.push("");
  lines.push(`Run: ${runUrl}`);
}

const output = `${lines.join("\n")}\n`;

if (outputPath) {
  fs.writeFileSync(outputPath, output);
} else {
  process.stdout.write(output);
}
