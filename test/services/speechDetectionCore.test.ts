/** @jest-environment node */
import { assessWavSpeech } from "../../src/services/speechDetectionCore";
import {
  createSpeechCoverage,
  DEFAULT_SPEECH_POLICY,
} from "../../src/services/speechDetectionPolicy";
import type { SileroSession } from "../../src/services/speechDetectionTypes";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import manifest from "../fixtures/speech-detection/manifest.json";
import pythonReference from "../fixtures/speech-detection/python-reference.json";
import { withoutNativePciWarning } from "../helpers/nativeRuntimeDiagnostics";

const wavFromSamples = (samples: number[], channels = 1): Buffer => {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000 * channels, 28);
  wav.writeUInt16LE(2 * channels, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
  return wav;
};

const probabilitiesSession = (probabilities: number[]): SileroSession => {
  let frame = 0;
  return {
    async infer() {
      const probability = probabilities[frame++];
      if (probability === undefined) throw new Error("Unexpected extra frame");
      return { probability, state: new Float32Array(256) };
    },
  };
};

const fixtureMonoSamples = (wav: Buffer): number[] => {
  // Independently checked FFmpeg fixture layout: stereo s16le, LIST chunk, data at 78.
  expect(wav.toString("ascii", 70, 74)).toBe("data");
  expect(wav.readUInt16LE(22)).toBe(2);
  const samples: number[] = [];
  for (let offset = 78; offset < wav.length; offset += 4) {
    samples.push(
      Math.round((wav.readInt16LE(offset) + wav.readInt16LE(offset + 2)) / 2),
    );
  }
  return samples;
};

describe("whole-clip speech assessment", () => {
  it("returns speech at the second consecutive positive frame without scanning the remaining clip", async () => {
    const assessment = await assessWavSpeech(
      wavFromSamples(Array(512 * 10).fill(1000)),
      probabilitiesSession([0.5, 0.5]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(assessment).toMatchObject({
      kind: "speech",
      metrics: {
        scannedFrames: 2,
        totalFrames: 10,
        maxConsecutiveSpeechFrames: 2,
      },
    });
  });

  it.each([
    {
      name: "one high sample",
      highSamples: 1,
      quietSamples: 1024,
      quietAmplitude: 1000,
      kind: "uncertain",
    },
    {
      name: "512 high samples",
      highSamples: 512,
      quietSamples: 1024,
      quietAmplitude: 1000,
      kind: "uncertain",
    },
    {
      name: "513 high samples",
      highSamples: 513,
      quietSamples: 1536,
      quietAmplitude: 1000,
      kind: "non_speech",
    },
    {
      name: "residue above peak tenth",
      highSamples: 1,
      quietSamples: 1024,
      quietAmplitude: 1001,
      kind: "non_speech",
    },
    {
      name: "one residual frame",
      highSamples: 1,
      quietSamples: 512,
      quietAmplitude: 1000,
      kind: "non_speech",
    },
    {
      name: "pure impulse",
      highSamples: 1,
      quietSamples: 1024,
      quietAmplitude: 0,
      kind: "non_speech",
    },
  ])(
    "brief peak preserves only bounded negative ambiguity: $name",
    async ({ highSamples, quietSamples, quietAmplitude, kind }) => {
      const samples = [
        ...Array(highSamples).fill(10000),
        ...Array((512 - (highSamples % 512)) % 512).fill(0),
        ...Array(quietSamples).fill(quietAmplitude),
      ];
      const wav = wavFromSamples(samples);
      const original = Buffer.from(wav);
      const assessment = await assessWavSpeech(
        wav,
        probabilitiesSession(Array(Math.ceil(samples.length / 512)).fill(0.01)),
        DEFAULT_SPEECH_POLICY,
      );
      expect(assessment).toMatchObject({
        kind,
        metrics: {
          scannedFrames: Math.ceil(samples.length / 512),
          totalFrames: Math.ceil(samples.length / 512),
        },
      });
      expect(wav).toEqual(original);
    },
  );
  it("brief peak never downgrades positive model evidence", async () => {
    const result = await assessWavSpeech(
      wavFromSamples([32767, ...Array(511).fill(0), ...Array(1024).fill(100)]),
      probabilitiesSession([0.01, 0.5, 0.5]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(result.kind).toBe("speech");
  });
  it("includes the brief-peak rule in policy identity", () => {
    expect(DEFAULT_SPEECH_POLICY.policyFingerprint).toBe(
      "d2cef8e7030aeda5a73aaa88e07204d7807729d11ce2dae7a218c1a1ee0e1aef",
    );
  });
  it("binds coverage to the exact PCM view and policy without changing bytes", () => {
    const original = Buffer.from("xabcx");
    const coverage = createSpeechCoverage(
      original.subarray(1, 4),
      "test-policy",
    );
    expect(coverage).toEqual({
      pcmSha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      audioBytes: 3,
      policyFingerprint: "test-policy",
    });
    expect(original.toString()).toBe("xabcx");
  });
  it.each([
    { probabilities: [0.01, 0.35], kind: "uncertain" },
    { probabilities: [0.5, 0.01, 0.5], kind: "uncertain" },
    { probabilities: [0, 0.3499], kind: "non_speech" },
    { probabilities: [0.01, 0.01, 0.5, 0.5], kind: "speech" },
  ])(
    "uses complete evidence for $kind: $probabilities",
    async ({ probabilities, kind }) => {
      const assessment = await assessWavSpeech(
        wavFromSamples(Array(512 * probabilities.length).fill(0)),
        probabilitiesSession(probabilities),
        DEFAULT_SPEECH_POLICY,
      );
      expect(assessment).toMatchObject({
        kind,
        metrics: {
          scannedFrames: probabilities.length,
          totalFrames: probabilities.length,
        },
      });
    },
  );
  it("carries context and state within a clip and resets both on each assessment", async () => {
    const wav = wavFromSamples([...Array(512).fill(1000), 2000]);
    const wrapped = Buffer.concat([
      Buffer.from([8, 9, 10]),
      wav,
      Buffer.from([11]),
    ]);
    const original = Buffer.from(wrapped);
    let frame = 0;
    const session: SileroSession = {
      async infer(input, state) {
        const withinClip = frame++ % 2;
        expect(input).toHaveLength(576);
        expect(state).toHaveLength(256);
        if (withinClip === 0) {
          expect(input.subarray(0, 64)).toEqual(new Float32Array(64));
          expect(state).toEqual(new Float32Array(256));
          expect(input[64]).toBeCloseTo(0.05);
        } else {
          expect(input[0]).toBeCloseTo(0.05);
          expect(input[63]).toBeCloseTo(0.05);
          expect(input[64]).toBeCloseTo(0.1);
          expect(input.subarray(65)).toEqual(new Float32Array(511));
          expect(state).toEqual(new Float32Array(256).fill(3));
        }
        return {
          probability: withinClip === 0 ? 0.01 : 0.4,
          state: new Float32Array(256).fill(3),
        };
      },
    };
    const first = await assessWavSpeech(
      wrapped.subarray(3, wrapped.length - 1),
      session,
      DEFAULT_SPEECH_POLICY,
    );
    const second = await assessWavSpeech(
      wrapped.subarray(3, wrapped.length - 1),
      session,
      DEFAULT_SPEECH_POLICY,
    );
    expect(first).toMatchObject({
      kind: "uncertain",
      metrics: { scannedFrames: 2, totalFrames: 2 },
    });
    expect(second).toEqual(first);
    expect(wrapped).toEqual(original);
  });
  it("caps detector-only amplification at 100", async () => {
    const wav = wavFromSamples(Array(512).fill(1));
    const original = Buffer.from(wav);
    const assessment = await assessWavSpeech(
      wav,
      {
        async infer(input) {
          expect(input[64]).toBeCloseTo(100 / 32768);
          return { probability: 0.4, state: new Float32Array(256) };
        },
      },
      DEFAULT_SPEECH_POLICY,
    );
    expect(assessment).toMatchObject({
      kind: "uncertain",
      metrics: { gain: 100 },
    });
    expect(wav).toEqual(original);
  });
  it("doesNotRejectAntiPhaseSpeech", async () => {
    const speech = readFileSync(
      path.join(__dirname, "../fixtures/speech-detection/yes-normal.wav"),
    );
    const stereo: number[] = [];
    for (const sample of fixtureMonoSamples(speech)) {
      stereo.push(sample, -sample);
    }
    const result = await assessWavSpeech(
      wavFromSamples(stereo, 2),
      probabilitiesSession([]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "channel_cancellation",
    });
  });
  it("preserves near-cancelling channel energy below the RMS boundary", async () => {
    const result = await assessWavSpeech(
      wavFromSamples(Array.from({ length: 512 }, () => [1000, -900]).flat(), 2),
      probabilitiesSession([0.01]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "channel_cancellation",
    });
  });
  it("keeps the existing mean downmix at the RMS boundary", async () => {
    const result = await assessWavSpeech(
      wavFromSamples(
        Array.from({ length: 1024 }, () => [1000, -800]).flat(),
        2,
      ),
      probabilitiesSession([0.5, 0.5]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(result.kind).toBe("speech");
  });
  it("preserves transcription on a failed incomplete negative scan", async () => {
    let frames = 0;
    const result = await assessWavSpeech(
      wavFromSamples(Array(1024).fill(0)),
      {
        async infer() {
          if (frames++ === 1) throw new Error("Model failed");
          return { probability: 0.01, state: new Float32Array(256) };
        },
      },
      DEFAULT_SPEECH_POLICY,
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "worker_error",
    });
  });
  it.each([NaN, Infinity, -0.01, 1.01])(
    "preserves transcription for invalid probability %s",
    async (probability) => {
      const result = await assessWavSpeech(
        wavFromSamples(Array(1024).fill(0)),
        probabilitiesSession([0.01, probability]),
        DEFAULT_SPEECH_POLICY,
      );
      expect(result).toMatchObject({
        kind: "unavailable",
        reason: "invalid_output",
      });
    },
  );
  it.each([
    new Float32Array(255),
    new Float32Array(257),
    Float32Array.from({ length: 256 }, () => NaN),
    Float32Array.from({ length: 256 }, () => Infinity),
  ])(
    "preserves transcription for invalid recurrent state %#",
    async (state) => {
      const result = await assessWavSpeech(
        wavFromSamples(Array(512).fill(0)),
        {
          async infer() {
            return { probability: 0.01, state };
          },
        },
        DEFAULT_SPEECH_POLICY,
      );
      expect(result).toMatchObject({
        kind: "unavailable",
        reason: "invalid_output",
      });
    },
  );
  it.each([
    "empty",
    "truncated",
    "non_pcm",
    "wrong_rate",
    "wrong_depth",
    "partial_sample",
    "empty_data",
    "bad_riff",
    "bad_alignment",
    "bad_byte_rate",
    "missing_fmt",
    "duplicate_data",
    "truncated_chunk",
  ])("preserves transcription for invalid WAV: %s", async (invalid) => {
    let wav = wavFromSamples(Array(1024).fill(0));
    if (invalid === "empty") wav = Buffer.alloc(0);
    if (invalid === "truncated") wav = wav.subarray(0, wav.length - 2);
    if (invalid === "non_pcm") wav.writeUInt16LE(3, 20);
    if (invalid === "wrong_rate") wav.writeUInt32LE(48000, 24);
    if (invalid === "wrong_depth") wav.writeUInt16LE(8, 34);
    if (invalid === "partial_sample") {
      wav = wav.subarray(0, wav.length - 1);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.writeUInt32LE(2047, 40);
    }
    if (invalid === "empty_data") wav = wavFromSamples([]);
    if (invalid === "bad_riff") wav.write("RIFX");
    if (invalid === "bad_alignment") wav.writeUInt16LE(1, 32);
    if (invalid === "bad_byte_rate") wav.writeUInt32LE(10, 28);
    if (invalid === "missing_fmt") wav.write("JUNK", 12);
    if (invalid === "duplicate_data") {
      wav = Buffer.concat([wav, wav.subarray(36)]);
      wav.writeUInt32LE(wav.length - 8, 4);
    }
    if (invalid === "truncated_chunk") {
      wav = Buffer.concat([wav, Buffer.from("JUN")]);
      wav.writeUInt32LE(wav.length - 8, 4);
    }
    const result = await assessWavSpeech(
      wav,
      {
        async infer() {
          throw new Error("Invalid input must not run inference");
        },
      },
      DEFAULT_SPEECH_POLICY,
    );
    expect(result).toEqual({
      kind: "unavailable",
      reason: "invalid_input",
      policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
    });
  });
  it("reads signal through ancillary and odd-sized RIFF chunks", async () => {
    const original = wavFromSamples(Array(1024).fill(1000));
    const oddChunk = Buffer.from([74, 85, 78, 75, 3, 0, 0, 0, 9, 8, 7, 0]);
    const extended = Buffer.concat([
      original.subarray(0, 12),
      oddChunk,
      original.subarray(12),
      oddChunk,
    ]);
    extended.writeUInt32LE(extended.length - 8, 4);
    const frames: Float32Array[] = [];
    const result = await assessWavSpeech(
      extended,
      {
        async infer(input) {
          frames.push(input.slice());
          return { probability: 0.5, state: new Float32Array(256) };
        },
      },
      DEFAULT_SPEECH_POLICY,
    );
    expect(result.kind).toBe("speech");
    expect(frames).toHaveLength(2);
    expect(frames[0][64]).toBeCloseTo(0.1);
    expect(frames[1][0]).toBeCloseTo(0.1);
  });
  it("preservesASRForOnePlausibleFrame", async () => {
    const borderline = await assessWavSpeech(
      wavFromSamples(Array(1536).fill(0)),
      probabilitiesSession([0.01, 0.7, 0.01]),
      DEFAULT_SPEECH_POLICY,
    );
    const completeNegative = await assessWavSpeech(
      wavFromSamples(Array(1024).fill(0)),
      probabilitiesSession([0.01, 0.02]),
      DEFAULT_SPEECH_POLICY,
    );
    const consecutivePositive = await assessWavSpeech(
      wavFromSamples(Array(1024).fill(0)),
      probabilitiesSession([0.5, 0.5]),
      DEFAULT_SPEECH_POLICY,
    );
    expect(borderline.kind).toBe("uncertain");
    expect(completeNegative.kind).toBe("non_speech");
    expect(consecutivePositive.kind).toBe("speech");
    expect(completeNegative).toMatchObject({
      metrics: { scannedFrames: 2, totalFrames: 2 },
    });
  });
});

describe("real bundled model synthetic controls", () => {
  it("matches Python controls with independent per-clip state and unchanged WAV bytes", () => {
    const fixtureRoot = path.join(__dirname, "../fixtures/speech-detection");
    const controls = manifest.cases.map((item) => {
      const wav = readFileSync(path.join(fixtureRoot, item.file));
      expect(createHash("sha256").update(wav).digest("hex")).toBe(item.sha256);
      return { id: item.id, wav: wav.toString("base64") };
    });
    const quiet = readFileSync(path.join(fixtureRoot, "yes-quiet.wav"));
    const quietSamples = fixtureMonoSamples(quiet);
    const padded = wavFromSamples([
      ...Array(16000).fill(0),
      ...quietSamples,
      ...Array(16000).fill(0),
    ]);
    const impulse = wavFromSamples([
      32767,
      ...Array(1023).fill(0),
      ...quietSamples,
    ]);
    const speech = controls.find((item) => item.id === "yes-quiet");
    const silence = controls.find((item) => item.id === "tune-silence");
    if (!speech || !silence) throw new Error("Missing known synthetic control");
    const inputs = [
      ...controls,
      speech,
      silence,
      speech,
      silence,
      { id: "padded-quiet", wav: padded.toString("base64") },
      { id: "impulse-quiet", wav: impulse.toString("base64") },
    ];
    const transientCases = [
      { id: "sample-511", impulses: [[511, 32767]] },
      { id: "sample-512", impulses: [[512, 32767]] },
      {
        id: "straddle-511-512",
        impulses: [
          [511, 32767],
          [512, 32767],
        ],
      },
      {
        id: "split-straddle",
        impulses: [
          [511, 16384],
          [512, 16383],
        ],
      },
      {
        id: "two-separated",
        impulses: [
          [0, 32767],
          [1024, 32767],
        ],
      },
      {
        id: "two-unequal",
        impulses: [
          [0, 32767],
          [1024, 30000],
        ],
      },
    ];
    for (const item of transientCases) {
      const prefix = Array(1536).fill(0);
      for (const [offset, amplitude] of item.impulses)
        prefix[offset] = amplitude;
      inputs.push({
        id: `quiet-${item.id}`,
        wav: wavFromSamples([...prefix, ...quietSamples]).toString("base64"),
      });
      inputs.push({
        id: `transient-${item.id}`,
        wav: wavFromSamples([
          ...prefix,
          ...Array(quietSamples.length).fill(0),
        ]).toString("base64"),
      });
    }
    const loudTone = fixtureMonoSamples(
      readFileSync(path.join(fixtureRoot, "tune-tone.wav")),
    ).map((sample) => sample * 7);
    inputs.push({
      id: "loud-sustained-tone",
      wav: wavFromSamples(loudTone).toString("base64"),
    });
    const root = path.resolve(__dirname, "../..");
    const script = `
      const {readFileSync} = require('node:fs');
      const path = require('node:path');
      const {pathToFileURL} = require('node:url');
      require('ts-node/register/transpile-only');
      const {assessWavSpeech} = require('./src/services/speechDetectionCore');
      const {DEFAULT_SPEECH_POLICY} = require('./src/services/speechDetectionPolicy');
      const ort = require('onnxruntime-node');
      async function main() {
        const inputs = JSON.parse(readFileSync(0, 'utf8'));
        const session = await ort.InferenceSession.create(new Uint8Array(readFileSync('assets/speech-detection/silero-v6.2.1.onnx')), {executionProviders: ['cpu'], executionMode:'sequential', intraOpNumThreads:1, interOpNumThreads:1, enableCpuMemArena:false, enableMemPattern:false});
        const adapter = { async infer(input, state) {
          const result = await session.run({input: new ort.Tensor('float32', input, [1,576]), state: new ort.Tensor('float32', state, [2,1,128]), sr: new ort.Tensor('int64', BigInt64Array.of(16000n), [])});
          return {probability: result.output.data[0], state: result.stateN.data};
        }};
        try {
          const outputs = [];
          for (const item of inputs) {
            const wav = Buffer.from(item.wav, 'base64');
            const original = Buffer.from(wav);
            const assessment = await assessWavSpeech(wav, adapter, DEFAULT_SPEECH_POLICY);
            outputs.push({id: item.id, assessment, unchanged: wav.equals(original)});
          }
          process.stdout.write(JSON.stringify(outputs));
        } finally { await session.release(); }
      }
      main().catch(error => {process.stderr.write(error.stack); process.exitCode = 1});
    `;
    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: root,
      input: JSON.stringify(inputs),
      encoding: "utf8",
      timeout: 60000,
    });
    expect(withoutNativePciWarning(run.stderr)).toBe("");
    expect(run.status).toBe(0);
    const outputs = z
      .array(
        z.object({
          id: z.string(),
          unchanged: z.boolean(),
          assessment: z.object({
            kind: z.enum(["speech", "non_speech", "uncertain", "unavailable"]),
            policyFingerprint: z.string(),
            metrics: z
              .object({
                peakSpeechProbability: z.number(),
                maxConsecutiveSpeechFrames: z.number(),
                scannedFrames: z.number(),
                totalFrames: z.number(),
                gain: z.number(),
              })
              .optional(),
          }),
        }),
      )
      .parse(JSON.parse(run.stdout));
    expect(outputs).toHaveLength(28);
    for (let index = 0; index < 9; index++) {
      const reference = pythonReference.cases[index];
      expect(outputs[index].id).toBe(reference.id);
      expect(outputs[index].assessment.kind).toBe(
        reference.shouldTranscribe ? "speech" : "non_speech",
      );
      expect(outputs[index].unchanged).toBe(true);
      const metrics = outputs[index].assessment.metrics;
      if (!metrics) throw new Error("Expected scored control assessment");
      if (reference.shouldTranscribe) {
        expect(metrics.peakSpeechProbability).toBeGreaterThanOrEqual(0.5);
        expect(metrics.maxConsecutiveSpeechFrames).toBe(2);
      } else {
        expect(metrics.peakSpeechProbability).toBeCloseTo(
          reference.peakSpeechProbability,
          5,
        );
        expect(metrics.maxConsecutiveSpeechFrames).toBe(
          reference.maxConsecutiveSpeechFrames,
        );
      }
      expect(metrics.gain).toBeCloseTo(reference.gain, 12);
    }
    expect(outputs[9].assessment).toEqual(outputs[4].assessment);
    expect(outputs[10].assessment).toEqual(outputs[0].assessment);
    expect(outputs[11].assessment).toEqual(outputs[4].assessment);
    expect(outputs[12].assessment).toEqual(outputs[0].assessment);
    expect(outputs[13].assessment.kind).toBe("speech");
    expect(outputs[14].assessment.kind).toBe("uncertain");
    for (let index = 15; index < 27; index += 2) {
      expect(outputs[index].assessment.kind).toBe("uncertain");
      expect(outputs[index + 1].assessment.kind).toBe("non_speech");
    }
    expect(outputs[27].assessment.kind).toBe("non_speech");
    expect(
      outputs.every(
        (output) =>
          output.assessment.policyFingerprint ===
          DEFAULT_SPEECH_POLICY.policyFingerprint,
      ),
    ).toBe(true);
    expect(
      outputs.every(
        (output) =>
          output.assessment.kind === "speech" ||
          output.assessment.metrics?.scannedFrames ===
            output.assessment.metrics?.totalFrames,
      ),
    ).toBe(true);
    expect(outputs.every((output) => output.unchanged)).toBe(true);
  }, 65000);
});
