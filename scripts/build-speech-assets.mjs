import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "assets/speech-detection");
const manifest = JSON.parse(
  await readFile(path.join(source, "manifest.json"), "utf8"),
);
const model = await readFile(path.join(source, manifest.model.file));
if (
  manifest.model.file !== "silero-v6.2.1.onnx" ||
  manifest.model.sha256 !==
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3" ||
  createHash("sha256").update(model).digest("hex") !== manifest.model.sha256 ||
  model.length !== manifest.model.bytes
)
  throw Error("Speech model integrity mismatch");
const target = path.join(root, "dist/assets/speech-detection");
await mkdir(target, { recursive: true });
for (const file of [
  manifest.model.file,
  "manifest.json",
  "SILERO-LICENSE",
  "ONNXRUNTIME-LICENSE",
  "PROVENANCE.md",
])
  await cp(path.join(source, file), path.join(target, file));

// tsc completed before this script. Associate the exact source/compiled eval bytes.
const requireCompiled = createRequire(
  path.join(root, "dist/evals/transcriptionImplementation.js"),
);
const { writeTranscriptionBuildAssociation } = requireCompiled(
  "./transcriptionImplementation.js",
);
await writeTranscriptionBuildAssociation(root);
