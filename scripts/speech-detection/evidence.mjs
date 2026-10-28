import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const requireCompiled = createRequire(
  path.join(root, "dist/services/speechDetectionService.js"),
);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const readJson = async (file) =>
  JSON.parse(await readFile(file, "utf8"));
export const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
};
export const percentile = (values, p = 0.95) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;
export async function implementationProvenance() {
  const { collectTranscriptionImplementation } = requireCompiled(
    "../evals/transcriptionImplementation.js",
  );
  return collectTranscriptionImplementation(root);
}
export async function compiledProvenance() {
  return (await implementationProvenance()).compiledSha256;
}
export async function artifactWorkspace(output, artifactDir) {
  const base = path.resolve(artifactDir ?? ".cache/transcription-eval");
  const target = path.resolve(output ?? path.join(base, `${Date.now()}.json`));
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("invalid_artifact_path");
  await mkdir(base, { recursive: true });
  const temp = await mkdtemp(path.join(base, "run-"));
  return {
    output: target,
    temp,
    cleanup: async () => {
      if (path.dirname(temp) !== base) throw Error("invalid_cleanup_path");
      await rm(temp, { recursive: true, force: true });
    },
  };
}
