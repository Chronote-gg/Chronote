// Evaluation provenance only. Importing this module loads no detector or provider.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const TRANSCRIPTION_IMPLEMENTATION_SOURCES = [
  "src/constants.ts",
  "src/metrics.ts",
  "src/utils/audioNoiseGate.ts",
  "src/utils/transcriptionGuards.ts",
  "src/utils/transcriptionVote.ts",
  "src/utils/transcriptionText.ts",
  "src/utils/text.ts",
  "src/services/transcriptionAudioService.ts",
  "src/services/audioPersistenceService.ts",
  "src/services/audioSnippetService.ts",
  "src/services/transcriptionInputService.ts",
  "src/services/transcriptionService.ts",
  "src/services/transcriptionCoalesceService.ts",
  "src/services/speechDetectionService.ts",
  "src/services/speechDetectionPolicy.ts",
  "src/services/speechDetectionWorker.ts",
  "src/services/speechDetectionCore.ts",
  "src/services/speechDetectionTypes.ts",
  "src/services/transcriptionSelectionService.ts",
  "src/services/openaiClient.ts",
  "src/services/modelFactory.ts",
  "src/services/configService.ts",
  "src/evals/transcriptionCorpus.ts",
  "src/evals/transcriptionEvalPrompt.ts",
  "src/evals/transcriptionMetrics.ts",
  "src/evals/transcriptionQualityCase.ts",
  "src/evals/transcriptionQualityEval.ts",
  "src/evals/transcriptionVadReport.ts",
  "src/evals/transcriptionImplementation.ts",
];
export const TRANSCRIPTION_IMPLEMENTATION_COMPILED =
  TRANSCRIPTION_IMPLEMENTATION_SOURCES.map((file) =>
    file.replace(/^src\//, "").replace(/\.ts$/, ".js"),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hashMap = (files: string[]) =>
  z.object(Object.fromEntries(files.map((file) => [file, digest]))).strict();
export const transcriptionBuildSchema = z
  .object({
    version: z.literal(1),
    sourceSha256: hashMap(TRANSCRIPTION_IMPLEMENTATION_SOURCES),
    compiledSha256: hashMap(TRANSCRIPTION_IMPLEMENTATION_COMPILED),
    toolchain: z
      .object({
        typescriptVersion: z.string().min(1),
        tsconfigSha256: digest,
        packageSha256: digest,
        lockSha256: digest,
      })
      .strict(),
  })
  .strict();
export const transcriptionImplementationSchema = z
  .object({
    version: z.literal(1),
    loader: z.enum(["source", "compiled"]),
    sourceSha256: hashMap(TRANSCRIPTION_IMPLEMENTATION_SOURCES),
    compiledSha256: hashMap(TRANSCRIPTION_IMPLEMENTATION_COMPILED),
    build: transcriptionBuildSchema,
    buildAssociationSha256: digest,
  })
  .strict();
export const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || Array.isArray(item) || typeof item !== "object")
      return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")),
    );
  });
export const implementationHash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const repositoryRoot = path.resolve(__dirname, "../..");
const loadToolchain = createRequire(__filename);
const buildFile = (root: string) =>
  path.join(root, "dist/assets/speech-detection/eval-build.json");
async function currentBuild(root: string) {
  const hashes = async (base: string, files: string[]) =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          implementationHash(await fs.readFile(path.join(base, file))),
        ]),
      ),
    );
  return transcriptionBuildSchema.parse({
    version: 1,
    sourceSha256: await hashes(root, TRANSCRIPTION_IMPLEMENTATION_SOURCES),
    compiledSha256: await hashes(
      path.join(root, "dist"),
      TRANSCRIPTION_IMPLEMENTATION_COMPILED,
    ),
    toolchain: {
      typescriptVersion: loadToolchain("typescript/package.json").version,
      tsconfigSha256: implementationHash(
        await fs.readFile(path.join(root, "tsconfig.json")),
      ),
      packageSha256: implementationHash(
        await fs.readFile(path.join(root, "package.json")),
      ),
      lockSha256: implementationHash(
        await fs.readFile(path.join(root, "yarn.lock")),
      ),
    },
  });
}
// Called by the existing normal build after tsc. An association identifies bytes,
// not a signature proving that those bytes were executed or labels human-reviewed.
export async function writeTranscriptionBuildAssociation(
  root = repositoryRoot,
): Promise<void> {
  const record = await currentBuild(root);
  await fs.mkdir(path.dirname(buildFile(root)), { recursive: true });
  await fs.writeFile(buildFile(root), JSON.stringify(record, null, 2));
}
export async function collectTranscriptionImplementation(
  root = repositoryRoot,
) {
  try {
    const build = transcriptionBuildSchema.parse(
      JSON.parse(await fs.readFile(buildFile(root), "utf8")),
    );
    const actual = await currentBuild(root);
    if (stableJson(build) !== stableJson(actual)) throw Error("stale_build");
    return transcriptionImplementationSchema.parse({
      version: 1,
      loader: path.extname(__filename) === ".js" ? "compiled" : "source",
      sourceSha256: actual.sourceSha256,
      compiledSha256: actual.compiledSha256,
      build,
      buildAssociationSha256: implementationHash(stableJson(build)),
    });
  } catch {
    throw Error(
      "transcription_eval_build_required: run npm run build; build association is missing or stale",
    );
  }
}
