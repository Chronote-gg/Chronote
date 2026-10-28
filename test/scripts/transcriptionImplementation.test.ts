import { copyTranscriptionSourceCheckout } from "../helpers/compiledTranscriptionFixture";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  useCompiledTranscriptionFixture,
  unreviewedPcmManifest,
  prepareTranscriptionFixture,
} from "../helpers/compiledTranscriptionFixture";
import { removeOwnedFixture } from "../helpers/compiledSpeechDetectionFixture";
import { transcriptionBuildSchema } from "../../src/evals/transcriptionImplementation";
const root = path.resolve(__dirname, "../..");
let compiled: string;
useCompiledTranscriptionFixture(root, (directory) => {
  compiled = directory;
});
function run(
  changed:
    | "none"
    | "source"
    | "compiled"
    | "source-orchestration"
    | "compiled-orchestration"
    | "missing-build",
  entry = false,
  sourceRoot = compiled,
) {
  const clone = mkdtempSync(path.join(os.tmpdir(), "vad-build-contract-"));
  try {
    cpSync(path.join(sourceRoot, "dist"), path.join(clone, "dist"), {
      recursive: true,
    });
    const buildPath = path.join(
      clone,
      "dist/assets/speech-detection/eval-build.json",
    );
    const build = transcriptionBuildSchema.parse(
      JSON.parse(readFileSync(buildPath, "utf8")),
    );
    for (const file of [
      ...Object.keys(build.sourceSha256),
      "package.json",
      "tsconfig.json",
      "yarn.lock",
    ]) {
      mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
      cpSync(path.join(sourceRoot, file), path.join(clone, file));
    }
    if (changed === "source")
      writeFileSync(
        path.join(clone, "src/services/speechDetectionCore.ts"),
        "// changed source",
      );
    if (changed === "compiled")
      writeFileSync(
        path.join(clone, "dist/services/speechDetectionCore.js"),
        "// changed compiled implementation",
      );
    if (changed === "source-orchestration")
      writeFileSync(
        path.join(clone, "src/services/transcriptionService.ts"),
        "// changed production admission and selection",
      );
    if (changed === "compiled-orchestration")
      writeFileSync(
        path.join(clone, "dist/services/transcriptionService.js"),
        "// changed compiled production admission and selection",
      );
    if (changed === "missing-build") unlinkSync(buildPath);
    const pcm = Buffer.alloc(48000 * 4);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4000, i);
    writeFileSync(path.join(clone, "control.pcm"), pcm);
    const manifest = path.join(clone, "manifest.json"),
      output = path.join(clone, "artifacts/result.json");
    writeFileSync(
      manifest,
      JSON.stringify(unreviewedPcmManifest(pcm, "build control")),
    );
    const child = spawnSync(
      process.execPath,
      [
        ...(entry
          ? [path.join(clone, "dist/evals/transcriptionEval.js")]
          : [
              "-e",
              "require(process.argv[1]).runTranscriptionQualityEval(process.argv.slice(2)).catch((error)=>{console.error(error.message);process.exitCode=1})",
              path.join(clone, "dist/evals/transcriptionQualityEval.js"),
            ]),
        "--manifest",
        manifest,
        "--mode",
        "preflight",
        "--runs",
        "1",
        "--artifact-dir",
        path.join(clone, "artifacts"),
        "--output",
        output,
      ],
      {
        cwd: clone,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_PATH: path.join(root, "node_modules"),
          MOCK_MODE: "true",
          LANGFUSE_TRACING_ENABLED: "false",
          DOTENV_CONFIG_QUIET: "true",
        },
        timeout: 60000,
      },
    );
    return {
      status: child.status,
      stderr: child.stderr,
      report:
        child.status === 0
          ? JSON.parse(readFileSync(output, "utf8"))
          : undefined,
    };
  } finally {
    removeOwnedFixture(clone, "vad-build-contract-");
  }
}
test("fresh normal-build association identifies the compiled runner without provider work", () => {
  const result = run("none");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.report.implementation.loader).toBe("compiled");
  expect(result.report.summary.requests).toBe(0);
});
test.each([
  "source",
  "compiled",
  "source-orchestration",
  "compiled-orchestration",
  "missing-build",
] as const)(
  "%s identity mismatch stops real CLI before provider setup",
  (changed) => {
    const result = run(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transcription_eval_build_required");
    expect(result.stderr).not.toContain("OPENAI_API_KEY");
  },
);

test("manifest entry reports a fixed build-required category and actionable hint", () => {
  const result = run("missing-build", true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("transcription_eval_build_required");
  expect(result.stderr).toContain("Run npm run build.");
});

test("current-source provenance suite works in an owned checkout with no dist", async () => {
  const checkout = mkdtempSync(
    path.join(os.tmpdir(), "vad-build-contract-source-"),
  );
  try {
    copyTranscriptionSourceCheckout(root, checkout);
    expect(existsSync(path.join(checkout, "dist"))).toBe(false);
    const fixture = await prepareTranscriptionFixture(checkout, root);
    let result: ReturnType<typeof run>;
    try {
      result = run("none", false, fixture);
    } finally {
      removeOwnedFixture(fixture, "vad-build-contract-");
    }
    expect(result.status).toBe(0);
    expect(result.report.implementation.loader).toBe("compiled");
    expect(result.report.summary.requests).toBe(0);
    expect(existsSync(path.join(checkout, "dist"))).toBe(false);
  } finally {
    removeOwnedFixture(checkout, "vad-build-contract-");
  }
}, 60000);
