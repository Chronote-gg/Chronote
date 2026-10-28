import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { withoutNativePciWarning } from "../helpers/nativeRuntimeDiagnostics";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/speech-detection/runtime-smoke.mjs");
const model = path.join(root, "assets/speech-detection/silero-v6.2.1.onnx");
const runtime = path.join(root, "node_modules");

const run = (modelPath: string, runtimePath = runtime) => {
  const result = spawnSync(
    process.execPath,
    [script, "--runtime-dir", runtimePath, "--model", modelPath],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  return {
    exitCode: result.status,
    stderr: result.stderr,
    inferenceResults: result.stdout.split("\n").filter((line) => line.trim()),
  };
};

describe("speech detection runtime smoke CLI", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "speech-runtime-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("rejectsCorruptModelBeforeSessionCreation", () => {
    const corrupt = path.join(scratch, "corrupt.onnx");
    writeFileSync(corrupt, "not an ONNX model");
    const corruptModelRun = run(corrupt, path.join(scratch, "missing-runtime"));
    expect(corruptModelRun.exitCode).not.toBe(0);
    expect(corruptModelRun.inferenceResults).toHaveLength(0);
    expect(corruptModelRun.stderr).toContain("Model SHA-256 mismatch");
  });

  it("rejects a missing model without reporting inference", () => {
    const result = run(path.join(scratch, "missing.onnx"));
    expect(result.exitCode).not.toBe(0);
    expect(result.inferenceResults).toHaveLength(0);
    expect(result.stderr).toContain("ENOENT");
  });

  it("rejects a mismatched engine before loading its assets", () => {
    const packageRoot = path.join(scratch, "onnxruntime-node");
    mkdirSync(packageRoot);
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "onnxruntime-node", version: "1.29.0" }),
    );
    const result = run(model, scratch);
    expect(result.exitCode).not.toBe(0);
    expect(result.inferenceResults).toHaveLength(0);
    expect(result.stderr).toContain("Runtime version mismatch");
  });

  it("rejects corrupt native binding before inference", () => {
    const packageRoot = path.join(scratch, "onnxruntime-node");
    const manifest = JSON.parse(
      readFileSync(
        path.join(root, "assets/speech-detection/manifest.json"),
        "utf8",
      ),
    );
    const assets = [
      ...manifest.runtime.assets,
      ...manifest.runtime.platforms[`${process.platform}-${process.arch}`],
    ];
    mkdirSync(packageRoot, { recursive: true });
    copyFileSync(
      path.join(runtime, "onnxruntime-node/package.json"),
      path.join(packageRoot, "package.json"),
    );
    for (const asset of assets) {
      const target = path.join(packageRoot, asset.file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(runtime, "onnxruntime-node", asset.file), target);
    }
    const binding = `bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
    writeFileSync(path.join(packageRoot, binding), "corrupt native binding");
    const result = run(model, scratch);
    expect(result.exitCode).not.toBe(0);
    expect(result.inferenceResults).toHaveLength(0);
    expect(result.stderr).toContain(
      `Runtime asset SHA-256 mismatch: ${binding}`,
    );
  });

  it("runs real bundled inference and validates silence and recurrent state", () => {
    const result = run(model);
    expect(withoutNativePciWarning(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.inferenceResults).toHaveLength(1);
    const output = z
      .object({
        engine: z.literal("onnxruntime-node"),
        engineVersion: z.literal("1.30.0"),
        nodeVersion: z.string().startsWith("v24."),
        modelSha256: z.literal(
          "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
        ),
        stateShape: z.tuple([z.literal(2), z.literal(1), z.literal(128)]),
        silenceProbability: z.number().finite(),
        frames: z.literal(10),
        cpuThreads: z.literal(1),
      })
      .parse(JSON.parse(result.inferenceResults[0]));
    expect(output.silenceProbability).toBeGreaterThanOrEqual(0);
    expect(output.silenceProbability).toBeLessThan(0.35);
  });
});
