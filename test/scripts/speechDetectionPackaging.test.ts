/** @jest-environment node */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpeechFixture } from "../helpers/compiledSpeechDetectionFixture";
import { z } from "zod";

const root = path.resolve(__dirname, "../..");
let compiled: string;
function removeFixture(fixture: string): void {
  if (
    path.dirname(path.resolve(fixture)) !== path.resolve(tmpdir()) ||
    !path.basename(fixture).startsWith("chronote-packaging-")
  )
    throw Error("Unexpected cleanup path");
  rmSync(fixture, { recursive: true, force: true });
}
beforeAll(() => {
  compiled = mkdtempSync(path.join(tmpdir(), "chronote-packaging-build-"));
  compileSpeechFixture(root, compiled, [
    "services/speechDetectionService.ts",
    "services/speechDetectionWorker.ts",
  ]);
  cpSync(
    path.join(root, "scripts/speech-detection"),
    path.join(compiled, "scripts/speech-detection"),
    { recursive: true },
  );
  cpSync(
    path.join(root, "test/fixtures/speech-detection"),
    path.join(compiled, "test/fixtures/speech-detection"),
    { recursive: true },
  );
  cpSync(
    path.join(root, "node_modules/onnxruntime-node"),
    path.join(compiled, "node_modules/onnxruntime-node"),
    { recursive: true },
  );
  writeFileSync(
    path.join(compiled, "offline.cjs"),
    `const blocked=()=>{throw Error('Network forbidden in packaging proof')};globalThis.fetch=blocked;for(const name of ['node:http','node:https'])require(name).request=blocked;require('node:net').connect=blocked;require('node:tls').connect=blocked;`,
  );
}, 60000);
afterAll(() => {
  if (compiled) removeFixture(compiled);
});
function checkFixture(check: (fixture: string) => void): void {
  const fixture = mkdtempSync(path.join(tmpdir(), "chronote-packaging-case-"));
  try {
    cpSync(compiled, fixture, { recursive: true });
    check(fixture);
  } finally {
    removeFixture(fixture);
  }
}
function run(fixture: string) {
  return spawnSync(
    process.execPath,
    [
      "--require",
      path.join(fixture, "offline.cjs"),
      "scripts/speech-detection/runtime-smoke.mjs",
      "--compiled",
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      timeout: 45000,
      env: {
        ...process.env,
        NODE_PATH: path.join(root, "node_modules"),
        NODE_OPTIONS: `--require=${JSON.stringify(path.join(fixture, "offline.cjs"))}`,
      },
    },
  );
}
it(
  "compiledSmokeNeedsNoSourceTreeOrNetwork",
  () =>
    checkFixture((fixture) => {
      for (const file of ["src", "tsconfig.json", ".cache"])
        expect(existsSync(path.join(fixture, file))).toBe(false);
      const smoke = run(fixture);
      expect(smoke.stderr).toBe("");
      expect(smoke.status).toBe(0);
      const result = z
        .object({
          silence: z.object({ kind: z.literal("non_speech") }),
          normalSpeech: z.object({ kind: z.literal("speech") }),
          shutdownComplete: z.literal(true),
        })
        .parse(JSON.parse(smoke.stdout));
      expect(result.shutdownComplete).toBe(true);
      console.info("compiled packaging evidence", result);
    }),
  60000,
);
it.each([
  ["missing worker", "dist/services/speechDetectionWorker.js", "missing"],
  ["corrupt worker", "dist/services/speechDetectionWorker.js", "corrupt"],
  [
    "missing model",
    "dist/assets/speech-detection/silero-v6.2.1.onnx",
    "missing",
  ],
  [
    "corrupt model",
    "dist/assets/speech-detection/silero-v6.2.1.onnx",
    "corrupt",
  ],
  [
    "missing runtime",
    `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`,
    "missing",
  ],
  [
    "corrupt runtime",
    `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`,
    "corrupt",
  ],
  [
    "unsupported platform",
    "dist/assets/speech-detection/manifest.json",
    "platform",
  ],
  [
    "mismatched engine",
    "node_modules/onnxruntime-node/package.json",
    "version",
  ],
])(
  "fails explicitly for %s",
  (_name, file, damage) =>
    checkFixture((fixture) => {
      const target = path.join(fixture, file);
      if (damage === "missing") rmSync(target);
      else if (damage === "platform") {
        const manifest = JSON.parse(readFileSync(target, "utf8"));
        delete manifest.runtime.platforms[
          `${process.platform}-${process.arch}`
        ];
        writeFileSync(target, JSON.stringify(manifest));
      } else if (damage === "version")
        writeFileSync(
          target,
          readFileSync(target, "utf8").replace('"1.30.0"', '"1.29.0"'),
        );
      else writeFileSync(target, "corrupt packaging fixture");
      const result = run(fixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Speech runtime smoke failed:");
      expect(result.stderr).not.toContain("Unknown option");
    }),
  60000,
);
