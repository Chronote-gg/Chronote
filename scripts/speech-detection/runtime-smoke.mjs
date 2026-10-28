import { createHash } from "node:crypto";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const manifestPath = new URL(
  "../../assets/speech-detection/manifest.json",
  import.meta.url,
);
const modelSha256 =
  "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const { values } = parseArgs({
    options: {
      compiled: { type: "boolean", default: false },
      "runtime-dir": { type: "string" },
      model: { type: "string" },
    },
  });
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const servicePath = path.join(
    root,
    "dist/services/speechDetectionService.js",
  );
  const requireCompiled = createRequire(servicePath);
  if (values.compiled) {
    await readFile(path.join(root, "dist/services/speechDetectionWorker.js"));
    values.model = path.join(
      root,
      "dist/assets/speech-detection/silero-v6.2.1.onnx",
    );
  }
  if (!values.compiled && (!values["runtime-dir"] || !values.model)) {
    throw new Error(
      "Usage: runtime-smoke.mjs --runtime-dir <node_modules-directory> --model <onnx-path>",
    );
  }
  const { model, manifest } = await validateModel(values, root);
  const runtimeRoot = values.compiled
    ? path.dirname(path.dirname(requireCompiled.resolve("onnxruntime-node")))
    : path.resolve(values["runtime-dir"], "onnxruntime-node");
  const runtimePackage = await validateRuntime(runtimeRoot, manifest);
  if (values.compiled)
    return smokeCompiled(requireCompiled, servicePath, root, runtimePackage);
  await smokeEngine(runtimeRoot, model, runtimePackage);
}

async function validateModel(values, root) {
  // Validate model bytes before importing the engine or creating a session.
  const model = await readFile(path.resolve(values.model));
  if (sha256(model) !== modelSha256) throw new Error("Model SHA-256 mismatch");
  const manifest = JSON.parse(
    await readFile(
      values.compiled
        ? path.join(root, "dist/assets/speech-detection/manifest.json")
        : manifestPath,
      "utf8",
    ),
  );
  if (
    manifest.model.sha256 !== modelSha256 ||
    manifest.model.bytes !== model.length
  ) {
    throw new Error("Model manifest mismatch");
  }
  return { model, manifest };
}
async function validateRuntime(runtimeRoot, manifest) {
  const runtimePackage = JSON.parse(
    await readFile(path.join(runtimeRoot, "package.json"), "utf8"),
  );
  if (
    runtimePackage.name !== "onnxruntime-node" ||
    runtimePackage.version !== "1.30.0" ||
    manifest.runtime.version !== runtimePackage.version
  ) {
    throw new Error("Runtime version mismatch");
  }
  const native =
    manifest.runtime.platforms[`${process.platform}-${process.arch}`];
  if (!native) throw new Error("Unsupported runtime platform");
  for (const asset of [...manifest.runtime.assets, ...native]) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(
      path.join(runtimeRoot, asset.file),
    )) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (hash.digest("hex") !== asset.sha256 || bytes !== asset.bytes) {
      throw new Error(`Runtime asset SHA-256 mismatch: ${asset.file}`);
    }
  }
  return runtimePackage;
}
async function smokeCompiled(
  requireCompiled,
  servicePath,
  root,
  runtimePackage,
) {
  const { getSpeechDetector, shutdownSpeechDetector } =
    requireCompiled(servicePath);
  const started = performance.now();
  let silence;
  let normalSpeech;
  let coldStartMs;
  try {
    const detector = getSpeechDetector();
    if (!(await detector.warm()))
      throw new Error("Compiled production worker not ready");
    coldStartMs = performance.now() - started;
    silence = await detector.assess(
      await readFile(
        path.join(root, "test/fixtures/speech-detection/tune-silence.wav"),
      ),
      "slow",
    );
    normalSpeech = await detector.assess(
      await readFile(
        path.join(root, "test/fixtures/speech-detection/yes-normal.wav"),
      ),
      "slow",
    );
    if (silence.kind !== "non_speech" || normalSpeech.kind !== "speech") {
      throw new Error(
        `Compiled worker control mismatch: silence=${silence.kind}, speech=${normalSpeech.kind}`,
      );
    }
  } finally {
    await shutdownSpeechDetector();
  }
  process.stdout.write(
    JSON.stringify({
      engine: runtimePackage.name,
      engineVersion: runtimePackage.version,
      modelSha256,
      coldStartMs,
      startupAndInferenceMs: performance.now() - started,
      silence,
      normalSpeech,
      shutdownComplete: true,
    }) + "\n",
  );
}
async function smokeEngine(runtimeRoot, model, runtimePackage) {
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const ort = require(path.join(runtimeRoot, "dist/index.js"));
  const started = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ["cpu"],
    executionMode: "sequential",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  try {
    let state = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
    const context = new Float32Array(64);
    let silenceProbability = 0;
    // Carry recurrent state and the trailing 64 samples across ten 512-sample frames.
    for (let frame = 0; frame < 10; frame++) {
      const samples = new Float32Array(576);
      samples.set(context);
      const result = await session.run({
        input: new ort.Tensor("float32", samples, [1, 576]),
        state,
        sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
      });
      const probability = result.output.data[0];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("Invalid speech probability");
      }
      state = result.stateN;
      if (
        state.dims.join(",") !== "2,1,128" ||
        !state.data.every(Number.isFinite)
      ) {
        throw new Error("Invalid recurrent state");
      }
      context.set(samples.subarray(512));
      silenceProbability = Math.max(silenceProbability, probability);
    }
    if (silenceProbability >= 0.35)
      throw new Error("Silence probability exceeds rejection ceiling");
    process.stdout.write(
      JSON.stringify({
        engine: runtimePackage.name,
        engineVersion: runtimePackage.version,
        nodeVersion: process.version,
        modelSha256,
        silenceProbability,
        stateShape: [...state.dims],
        frames: 10,
        cpuThreads: 1,
        startupAndInferenceMs: performance.now() - started,
      }) + "\n",
    );
  } finally {
    await session.release();
  }
}

main().catch((error) => {
  process.stderr.write(`Speech runtime smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
