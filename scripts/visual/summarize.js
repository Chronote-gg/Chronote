const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const resultsIndex = args.indexOf("--results");
const outputIndex = args.indexOf("--output");
const runUrlIndex = args.indexOf("--run-url");
const snapshotChangesPathIndex = args.indexOf("--snapshot-changes");
const previewBaseUrlIndex = args.indexOf("--preview-base-url");
const headImageBaseUrlIndex = args.indexOf("--head-image-base-url");

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const MAX_INLINE_PREVIEWS = 24;

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
const previewBaseUrl =
  previewBaseUrlIndex >= 0 && args[previewBaseUrlIndex + 1]
    ? args[previewBaseUrlIndex + 1]
    : "";
const headImageBaseUrl =
  headImageBaseUrlIndex >= 0 && args[headImageBaseUrlIndex + 1]
    ? args[headImageBaseUrlIndex + 1]
    : "";

const diffFiles = [];

const isDiffImage = (fileName) =>
  IMAGE_EXTENSIONS.some((extension) => fileName.endsWith(`-diff${extension}`));

const isPreviewImage = (fileName) =>
  IMAGE_EXTENSIONS.some(
    (extension) =>
      fileName.endsWith(`-diff${extension}`) ||
      fileName.endsWith(`-actual${extension}`) ||
      fileName.endsWith(`-expected${extension}`),
  );

const isImagePath = (filePath) =>
  IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

const toPosixRelativePath = (filePath) =>
  path.relative(process.cwd(), filePath).split(path.sep).join("/");

const encodePath = (filePath) =>
  filePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

const buildImageUrl = (baseUrl, filePath) => {
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/+$/, "")}/${encodePath(filePath)}`;
};

const findSiblingImage = (diffFilePath, kind) => {
  const parsed = path.parse(diffFilePath);
  const stem = parsed.name.replace(/-diff$/, "");
  return IMAGE_EXTENSIONS.map((extension) =>
    path.join(parsed.dir, `${stem}-${kind}${extension}`),
  ).find((candidate) => fs.existsSync(candidate));
};

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      return;
    }
    if (entry.isFile() && isDiffImage(entry.name)) {
      diffFiles.push(fullPath);
    }
  });
}

const parseNameStatusLine = (line) => {
  const tabParts = line.split("\t");
  const [status, ...fileParts] =
    tabParts.length > 1 ? tabParts : line.split(/\s+/);
  if (/^[RC]\d+/.test(status) && fileParts.length >= 2) {
    const currentPath = fileParts.slice(1).join(" ");
    return {
      currentPath,
      deleted: false,
      display: `${status}: ${fileParts[0]} -> ${currentPath}`,
      status,
    };
  }
  const currentPath = fileParts.join(" ");
  return {
    currentPath,
    deleted: status.startsWith("D"),
    display: `${status}: ${currentPath}`,
    status,
  };
};

const previewName = (filePath) =>
  path.basename(filePath).replace(/-diff\.(png|jpg|jpeg)$/, "");

const createDiffPreview = (filePath) => {
  const relativePath = toPosixRelativePath(filePath);
  const actualPath = findSiblingImage(filePath, "actual");
  const expectedPath = findSiblingImage(filePath, "expected");

  return {
    actualUrl: actualPath
      ? buildImageUrl(previewBaseUrl, toPosixRelativePath(actualPath))
      : "",
    expectedUrl: expectedPath
      ? buildImageUrl(previewBaseUrl, toPosixRelativePath(expectedPath))
      : "",
    imageUrl: buildImageUrl(previewBaseUrl, relativePath),
    label: previewName(filePath),
  };
};

const createSnapshotPreview = (change) => ({
  imageUrl: buildImageUrl(headImageBaseUrl, change.currentPath),
  label: change.currentPath,
});

const appendPreviewSection = (lines, title, previews, options = {}) => {
  const inlinePreviews = previews.slice(0, MAX_INLINE_PREVIEWS);

  lines.push(`### ${title}`);
  lines.push(options.open ? "<details open>" : "<details>");
  lines.push(
    `<summary>${previews.length} image preview${previews.length === 1 ? "" : "s"}</summary>`,
  );
  lines.push("");
  inlinePreviews.forEach((preview) => {
    lines.push(`#### ${preview.label}`);
    lines.push(`![${preview.label}](${preview.imageUrl})`);
    const siblingLinks = [
      preview.actualUrl ? `[Actual](${preview.actualUrl})` : "",
      preview.expectedUrl ? `[Expected](${preview.expectedUrl})` : "",
    ].filter(Boolean);
    if (siblingLinks.length > 0) {
      lines.push(siblingLinks.join(" | "));
    }
    lines.push("");
  });

  if (previews.length > MAX_INLINE_PREVIEWS) {
    lines.push(
      `${previews.length - MAX_INLINE_PREVIEWS} additional preview images are available in the workflow artifact.`,
    );
    lines.push("");
  }

  lines.push("</details>");
  lines.push("");
};

walk(path.resolve(resultsDir));

const snapshotChanges =
  snapshotChangesPath && fs.existsSync(snapshotChangesPath)
    ? fs
        .readFileSync(snapshotChangesPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseNameStatusLine)
    : [];

const names = diffFiles.map(previewName).sort((a, b) => a.localeCompare(b));
const diffPreviews = previewBaseUrl
  ? diffFiles
      .filter((filePath) => isPreviewImage(path.basename(filePath)))
      .map(createDiffPreview)
      .sort((a, b) => a.label.localeCompare(b.label))
  : [];
const snapshotPreviews = headImageBaseUrl
  ? snapshotChanges
      .filter((change) => !change.deleted && isImagePath(change.currentPath))
      .map(createSnapshotPreview)
  : [];

const lines = [];
lines.push("[AGENT]");
lines.push("");
lines.push("## Visual regression report");
if (snapshotChanges.length > 0) {
  lines.push(
    `Committed baseline snapshot updates in this PR: ${snapshotChanges.length}.`,
  );
  lines.push("");
  lines.push("Committed snapshot files:");
  snapshotChanges.forEach((change) => lines.push(`- ${change.display}`));
  lines.push("");
  if (snapshotPreviews.length > 0) {
    appendPreviewSection(
      lines,
      "Committed baseline previews",
      snapshotPreviews,
    );
  }
}
if (names.length === 0) {
  lines.push("No visual diffs detected.");
} else {
  lines.push(`Detected ${names.length} screenshot changes.`);
  lines.push("");
  lines.push("Changed snapshots:");
  names.forEach((name) => lines.push(`- ${name}`));
  lines.push("");
  if (diffPreviews.length > 0) {
    appendPreviewSection(lines, "Generated diff previews", diffPreviews, {
      open: true,
    });
  }
}
lines.push(
  "Download the `visual-regression` artifact and open `playwright-report/index.html` for the full report.",
);
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
