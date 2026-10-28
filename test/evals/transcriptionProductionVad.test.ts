/** @jest-environment node */
import { writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  useCompiledTranscriptionFixture,
  unreviewedPcmManifest,
} from "../helpers/compiledTranscriptionFixture";
import { runTranscriptionQualityEval } from "../../src/evals/transcriptionQualityEval";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTranscriptionQualityCase } from "../../src/evals/transcriptionQualityCase";
import { selectCorpusBatch } from "../../src/evals/transcriptionCorpus";
import type {
  SpeechAssessment,
  SpeechDetector,
} from "../../src/services/speechDetectionTypes";
const pcm = Buffer.alloc(48000 * 4);
for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4000, i);
const options = {
  pcm,
  prompt: "",
  passMode: "slow" as const,
  policy: {},
  force: false,
};
const root = path.resolve(__dirname, "../..");
let compiled: string;
useCompiledTranscriptionFixture(root, (directory) => {
  compiled = directory;
});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "vad-eval-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const production = (assessment: SpeechAssessment) => ({
  mode: "enforce" as const,
  pcmFile: path.join(dir, "input.pcm"),
  wavFile: path.join(dir, "input.wav"),
  policyFingerprint: "test",
  detector: {
    warm: async () => true,
    shutdown: async () => {},
    assess: async () => assessment,
  } satisfies SpeechDetector,
});
test("productionDetectorSkipsWithoutInventingSuccessfulSpeechScores", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    production: production({
      kind: "non_speech",
      policyFingerprint: "test",
      metrics: {
        peakSpeechProbability: 0,
        maxConsecutiveSpeechFrames: 0,
        scannedFrames: 1,
        totalFrames: 1,
        gain: 1,
      },
    }),
    transcribe: async () => ({ text: "invented" }),
  });
  expect(result).toMatchObject({
    status: "skipped",
    requests: 0,
    score: { scored: false },
  });
});
test("unavailableAssessmentStillCallsProvider", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    production: production({
      kind: "unavailable",
      reason: "worker_error",
      policyFingerprint: "test",
    }),
    transcribe: async () => ({ text: "hello" }),
  });
  expect(result).toMatchObject({
    status: "succeeded",
    requests: 1,
    assessment: { kind: "unavailable" },
  });
});
test("preflight eligible remains unscored", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "preflight",
    reference: "hello",
    production: production({
      kind: "unavailable",
      reason: "not_ready",
      policyFingerprint: "test",
    }),
    transcribe: async () => {
      throw Error("forbidden");
    },
  });
  expect(result).toMatchObject({
    status: "eligible",
    requests: 0,
    score: { scored: false },
  });
});
test("batch ordering neither loses duplicates nor changes labels and hashes", () => {
  const cases = Array.from({ length: 53 }, (_, i) => ({
    id: `case-${String(52 - i).padStart(2, "0")}`,
    sha256: String(i),
    label: { kind: "speech" },
  }));
  const batches = [0, 1, 2].flatMap((index) =>
    selectCorpusBatch(cases, 25, index),
  );
  expect(batches).toEqual([...cases].sort((a, b) => a.id.localeCompare(b.id)));
  expect(() => selectCorpusBatch(cases, 25, 3)).toThrow();
  expect(() => selectCorpusBatch(cases, 26, 0)).toThrow();
});

test("sanitizes provider status without retaining private error text", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    transcribe: async () => {
      throw Object.assign(
        new Error("private https://secret.example/audio?token=sensitive"),
        { status: 429 },
      );
    },
  });
  expect(result.error).toEqual({ category: "request_error", status: 429 });
  expect(JSON.stringify(result)).not.toContain("secret.example");
});

test("invalid batch and conflicting VAD options stop before source decode or provider setup", async () => {
  const manifest = path.join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      name: "test",
      cases: [
        {
          id: "one",
          file: "missing.wav",
          sha256: "a".repeat(64),
          split: "holdout",
          label: { kind: "unreviewed" },
        },
      ],
    }),
  );
  await expect(
    runTranscriptionQualityEval(["--manifest", manifest, "--batch-index", "1"]),
  ).rejects.toThrow("Invalid corpus batch");
  await expect(
    runTranscriptionQualityEval([
      "--manifest",
      manifest,
      "--speech-detector",
      "production",
      "--vad-report",
      "missing.json",
    ]),
  ).rejects.toThrow("conflicts");
});
test("25 slow cases repeated three times require no more than 150 SDK attempts", async () => {
  let total = 0;
  for (let i = 0; i < 75; i++) {
    const r = await runTranscriptionQualityCase({
      ...options,
      prompt: "Dictionary: The Den",
      mode: "pipeline",
      transcribe: async () => {
        total++;
        return { text: "The Den", logprobs: [{ logprob: -3 }] };
      },
    });
    expect(r.requests).toBe(2);
  }
  expect(total).toBe(150);
});

test("shadow submits provider work before detector completion", async () => {
  let finish!: (value: SpeechAssessment) => void;
  const pending = new Promise<SpeechAssessment>((resolve) => {
    finish = resolve;
  });
  const detector: SpeechDetector = {
    warm: async () => true,
    shutdown: async () => {},
    assess: () => pending,
  };
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    production: {
      ...production({
        kind: "unavailable",
        reason: "not_ready",
        policyFingerprint: "test",
      }),
      mode: "shadow",
      detector,
    },
    transcribe: async () => {
      finish({
        kind: "unavailable",
        reason: "timeout",
        policyFingerprint: "test",
      });
      return { text: "hello" };
    },
  });
  expect(result.requests).toBe(1);
  expect(result.assessment).toMatchObject({
    kind: "unavailable",
    reason: "timeout",
  });
});

test("manifest CLI executes compiled runner and reports its actual loader", async () => {
  const audio = path.join(dir, "control.pcm");
  await writeFile(audio, pcm);
  const manifest = path.join(dir, "cli-manifest.json"),
    output = path.join(dir, "cli-output.json");
  await writeFile(
    manifest,
    JSON.stringify(unreviewedPcmManifest(pcm, "loader control")),
  );
  const cli = spawnSync(
    process.execPath,
    [
      "-r",
      require.resolve("ts-node/register"),
      path.join(compiled, "src/evals/transcriptionEval.ts"),
      "--manifest",
      manifest,
      "--mode",
      "preflight",
      "--runs",
      "1",
      "--artifact-dir",
      dir,
      "--output",
      output,
    ],
    {
      encoding: "utf8",
      cwd: compiled,
      env: {
        ...process.env,
        NODE_PATH: path.join(root, "node_modules"),
        TS_NODE_TRANSPILE_ONLY: "true",
        TS_NODE_PROJECT: path.join(root, "tsconfig.json"),
        DOTENV_CONFIG_QUIET: "true",
      },
      timeout: 60000,
    },
  );
  expect(cli.stderr).toBe("");
  expect(cli.status).toBe(0);
  const report = JSON.parse(await readFile(output, "utf8"));
  expect(report.implementation.loader).toBe("compiled");
  expect(report.implementation.buildAssociationSha256).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(report.summary.requests).toBe(0);
  expect(report.results[0].score.scored).toBe(false);
});

// Run the public compiled corpus runner. Control external work durations without
// replacing the case, preparation helper, gates, cleanup or report assembly.
test.each([
  ["off", "pipeline", 120, null],
  ["enforce", "pipeline", 135, 15],
  ["shadow", "pipeline", 120, 200],
  ["off", "provider", 120, null],
] as const)(
  "%s %s measures per-attempt conversion, provider and cleanup at the same boundary",
  async (speechMode, mode, durationMs, assessmentMs) => {
    const inputs = [
      { id: "admitted", bytes: pcm },
      ...(mode === "pipeline"
        ? [
            { id: "short", bytes: pcm.subarray(0, 19200) },
            { id: "silence", bytes: Buffer.alloc(pcm.length) },
          ]
        : []),
    ];
    for (const input of inputs)
      await writeFile(path.join(dir, `${input.id}.pcm`), input.bytes);
    const manifest = path.join(dir, "timing-manifest.json"),
      output = path.join(dir, "timing-output.json"),
      counts = path.join(dir, "counts.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        name: "timing controls",
        prompt: "",
        cases: inputs.map((input) => ({
          id: input.id,
          file: `${input.id}.pcm`,
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
          split: "holdout",
          label: { kind: "unreviewed" },
        })),
      }),
    );
    const control = path.join(dir, "timing-control.cjs");
    await writeFile(
      control,
      `
    const fs = require('node:fs'), path = require('node:path');
    let now = 0, conversions = 0, submissions = 0, assessments = 0, cleanups = 0, completeShadow;
    Object.defineProperty(globalThis, 'performance', { value: { now: () => now } });
    Date.now = () => now;
    const root = process.argv[2], speechMode = process.argv[3], mode = process.argv[4];
    const compiled = (file) => require(path.join(root, 'dist', file));
    compiled('services/transcriptionAudioService.js').convertTranscriptionPcmToWav = async (pcm, wav) => {
      conversions++; now += 40; fs.copyFileSync(pcm, wav);
    };
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (file) => { unlink(file); now += 5; cleanups++; };
    compiled('services/openaiClient.js').createOpenAIClient = () => ({ withOptions: () => ({ audio: { transcriptions: { create: async ({file}) => {
      for await (const chunk of file) { void chunk; } submissions++; now += 70; if (completeShadow) setImmediate(completeShadow); return { text: 'hello', logprobs: [] };
    } } } }) });
    const service = compiled('services/speechDetectionService.js');
    service.getSpeechDetector = () => ({ warm: async () => true, shutdown: async () => {}, assess: async () => {
      assessments++;
      if (speechMode === 'shadow') await new Promise((resolve) => { completeShadow = resolve; });
      now += speechMode === 'shadow' ? 120 : 15;
      return { kind: 'unavailable', reason: 'not_ready', policyFingerprint: compiled('services/speechDetectionPolicy.js').DEFAULT_SPEECH_POLICY.policyFingerprint };
    } });
    service.shutdownSpeechDetector = async () => {};
    compiled('evals/transcriptionQualityEval.js').runTranscriptionQualityEval([
      '--manifest', process.argv[5], '--mode', mode, '--runs', '3', '--max-requests', '3',
      '--model', 'controlled-model', '--artifact-dir', process.argv[6], '--output', process.argv[7],
      '--speech-detector', speechMode === 'off' ? 'off' : 'production', ...(speechMode === 'off' ? [] : ['--speech-mode', speechMode])
    ]).then(() => fs.writeFileSync(process.argv[8], JSON.stringify({ conversions, submissions, assessments, cleanups }))).catch((error) => { console.error(error); process.exitCode = 1; });
  `,
    );
    const child = spawnSync(
      process.execPath,
      [control, compiled, speechMode, mode, manifest, dir, output, counts],
      {
        cwd: compiled,
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
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(JSON.parse(await readFile(counts, "utf8"))).toEqual({
      conversions: 3,
      submissions: 3,
      assessments: speechMode === "off" ? 0 : 3,
      cleanups: 6,
    });
    const admitted = report.results.filter(
      (row: { caseId: string }) => row.caseId === "admitted",
    );
    expect(admitted).toHaveLength(3);
    for (const row of admitted) {
      expect(row.durationMs).toBe(durationMs);
      expect(row.stages).toMatchObject({
        conversionMs: 40,
        providerMs: 70,
        admissionMs: speechMode === "enforce" ? 55 : 40,
        assessmentMs,
      });
      expect(row.requests).toBe(1);
    }
    const skipped = report.results.filter(
      (row: { status: string }) => row.status === "skipped",
    );
    expect(skipped).toHaveLength(mode === "pipeline" ? 6 : 0);
    for (const row of skipped)
      expect(row.stages).toMatchObject({
        conversionMs: 0,
        admissionMs: 0,
        assessmentMs: null,
        providerMs: 0,
      });
    expect(report.implementation.loader).toBe("compiled");
    expect(report.summary.requests).toBe(3);
  },
);
