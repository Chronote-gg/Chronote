import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_SPEECH_POLICY } from "./speechDetectionPolicy";
import { assessWavSpeech } from "./speechDetectionCore";
import type { SileroSession, SpeechWorkerReply } from "./speechDetectionTypes";

// shortcut: synchronous hangs cannot handle owner loss outside containers; add a watchdog if that runtime is supported.
process.once("disconnect", () => process.exit());

const assetSchema = z.object({
  file: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string(),
});
const manifestSchema = z.object({
  model: assetSchema,
  runtime: z.object({
    package: z.literal("onnxruntime-node"),
    version: z.literal("1.30.0"),
    assets: z.array(assetSchema).length(4),
    platforms: z.record(z.string(), z.array(assetSchema).min(2)),
  }),
});
const requestSchema = z.object({
  type: z.literal("assess"),
  requestId: z.number().int().positive(),
  wav: z.instanceof(ArrayBuffer),
  policyFingerprint: z.literal(DEFAULT_SPEECH_POLICY.policyFingerprint),
});
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function verifyRuntimeAsset(
  root: string,
  asset: z.infer<typeof assetSchema>,
): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path.join(root, asset.file))) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  if (hash.digest("hex") !== asset.sha256 || bytes !== asset.bytes)
    throw Error("Runtime integrity mismatch");
}

async function loadSession(): Promise<
  import("onnxruntime-node").InferenceSession
> {
  try {
    z.literal(DEFAULT_SPEECH_POLICY.policyFingerprint).parse(process.argv[2]);
    const assets = path.resolve(
      __dirname,
      path.extname(__filename) === ".ts"
        ? "../../assets/speech-detection"
        : "../assets/speech-detection",
    );
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(assets, "manifest.json"), "utf8")),
    );
    if (
      manifest.model.file !== "silero-v6.2.1.onnx" ||
      manifest.model.sha256 !== DEFAULT_SPEECH_POLICY.modelSha256
    )
      throw Error("Model manifest mismatch");
    const model = await readFile(path.join(assets, manifest.model.file));
    if (
      sha256(model) !== DEFAULT_SPEECH_POLICY.modelSha256 ||
      model.length !== manifest.model.bytes
    )
      throw Error("Model integrity mismatch");
    const runtimeEntry = require.resolve("onnxruntime-node");
    const runtimeRoot = path.dirname(path.dirname(runtimeEntry));
    const runtimePackage = z
      .object({
        name: z.literal("onnxruntime-node"),
        version: z.literal("1.30.0"),
      })
      .parse(
        JSON.parse(
          await readFile(path.join(runtimeRoot, "package.json"), "utf8"),
        ),
      );
    if (
      DEFAULT_SPEECH_POLICY.engineVersion !==
      `${runtimePackage.name}@${runtimePackage.version}`
    )
      throw Error("Runtime policy mismatch");
    const expectedFiles = [
      "dist/index.js",
      "dist/backend.js",
      "dist/binding.js",
      "dist/version.js",
    ];
    if (
      manifest.runtime.assets.map((asset) => asset.file).join(",") !==
      expectedFiles.join(",")
    )
      throw Error("Runtime manifest mismatch");
    const native =
      manifest.runtime.platforms[`${process.platform}-${process.arch}`];
    if (
      !native ||
      !native.some(
        (asset) =>
          asset.file ===
          `bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`,
      )
    )
      throw Error("Unsupported runtime platform");
    for (const asset of [...manifest.runtime.assets, ...native])
      await verifyRuntimeAsset(runtimeRoot, asset);
    const ort = await import("onnxruntime-node");
    return await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ["cpu"],
      executionMode: "sequential",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
  } catch {
    throw Error("asset_error");
  }
}

async function main(): Promise<void> {
  if (!process.send || !process.connected) throw Error("worker_error");
  const send = (reply: SpeechWorkerReply): void => {
    process.send?.(reply);
  };
  const session = await loadSession();
  const ort = await import("onnxruntime-node");
  const silero: SileroSession = {
    async infer(input, state) {
      const output = await session.run({
        input: new ort.Tensor("float32", input, [1, 576]),
        state: new ort.Tensor("float32", state, [2, 1, 128]),
        sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
      });
      if (
        output.output.type !== "float32" ||
        output.output.data.length !== 1 ||
        output.stateN.type !== "float32" ||
        output.stateN.dims.join(",") !== "2,1,128"
      )
        throw Error("invalid_output");
      return {
        probability: z.number().parse(output.output.data[0]),
        state: z.instanceof(Float32Array).parse(output.stateN.data),
      };
    },
  };
  // Run one frame before readiness so lazy engine work stays in bounded startup.
  // assessWavSpeech owns fresh recurrent/context state, discarded after this call.
  const silence = Buffer.alloc(44 + DEFAULT_SPEECH_POLICY.frameSamples * 2);
  silence.write("RIFF", 0);
  silence.writeUInt32LE(silence.length - 8, 4);
  silence.write("WAVEfmt ", 8);
  silence.writeUInt32LE(16, 16);
  silence.writeUInt16LE(1, 20);
  silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(DEFAULT_SPEECH_POLICY.sampleRate, 24);
  silence.writeUInt32LE(DEFAULT_SPEECH_POLICY.sampleRate * 2, 28);
  silence.writeUInt16LE(2, 32);
  silence.writeUInt16LE(16, 34);
  silence.write("data", 36);
  silence.writeUInt32LE(silence.length - 44, 40);
  const primed = await assessWavSpeech(silence, silero, DEFAULT_SPEECH_POLICY);
  if (primed.kind === "unavailable") {
    await session.release();
    throw Error(primed.reason);
  }
  let busy = false;
  process.on("message", async (message: unknown) => {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success || busy) throw Error("invalid_output");
    busy = true;
    try {
      const request = parsed.data;
      const assessment = await assessWavSpeech(
        new Uint8Array(request.wav),
        silero,
        DEFAULT_SPEECH_POLICY,
      );
      send({
        type: "assessment",
        requestId: request.requestId,
        assessment,
      } satisfies SpeechWorkerReply);
    } finally {
      busy = false;
    }
  });
  send({
    type: "ready",
    policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
  } satisfies SpeechWorkerReply);
}
void main().catch((error) => {
  process.exitCode = 1;
  const reason =
    error instanceof Error && error.message === "asset_error"
      ? "asset_error"
      : "worker_error";
  process.send?.({ type: "failure", reason } satisfies SpeechWorkerReply, () =>
    process.exit(1),
  );
});
