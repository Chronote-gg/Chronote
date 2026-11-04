/** @jest-environment node */
import { copyTranscriptionSourceCheckout } from "../helpers/compiledTranscriptionFixture";
import { TRANSCRIPTION_IMPLEMENTATION_SOURCES } from "../../src/evals/transcriptionImplementation";
import { DEFAULT_SPEECH_POLICY } from "../../src/services/speechDetectionPolicy";
import { serialize, deserialize } from "node:v8";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  prepareTranscriptionAcceptanceFixture,
  TRANSCRIPTION_FIXTURE_SETUP_TIMEOUT_MS,
} from "../helpers/compiledTranscriptionFixture";
import { removeOwnedFixture } from "../helpers/compiledSpeechDetectionFixture";
import { runTranscriptionQualityCase } from "../../src/evals/transcriptionQualityCase";
const root = path.resolve(__dirname, "../..");
let compiled: string;
beforeAll(async () => {
  compiled = await prepareTranscriptionAcceptanceFixture(root);
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `
    for (const file of ['speechDetectionPolicy', '../evals/transcriptionCorpus', '../evals/transcriptionMetrics'])
      require('./dist/services/' + file + '.js');
    require('./dist/evals/transcriptionImplementation.js').collectTranscriptionImplementation()
      .then((record) => console.log(record.loader)).catch((error) => { console.error(error); process.exitCode = 1; });
  `,
    ],
    {
      cwd: compiled,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
    },
  );
  expect(probe.stderr).toBe("");
  expect(probe.status).toBe(0);
  expect(probe.stdout.trim()).toBe("compiled");
}, TRANSCRIPTION_FIXTURE_SETUP_TIMEOUT_MS);
afterAll(() => {
  if (compiled) removeOwnedFixture(compiled, "vad-build-contract-");
});
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const sourceFiles = TRANSCRIPTION_IMPLEMENTATION_SOURCES;
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const assessment = (kind: string) => ({
  kind,
  policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
  metrics: {
    peakSpeechProbability: kind === "speech" ? 0.9 : 0.1,
    maxConsecutiveSpeechFrames: kind === "speech" ? 2 : 0,
    scannedFrames: 2,
    totalFrames: 2,
    gain: 1,
  },
});
function fixture() {
  const cases = Array.from({ length: 150 }, (_, i) => ({
    id: `clip${i}`,
    file: `clip${i}.wav`,
    sha256: hash(String(i)),
    split: "holdout",
    familyId: `family${i}`,
    speakerDeviceProfileId: `profile${i % 5}`,
    tags: i < 20 ? ["quiet", "short"] : [],
    label:
      i < 100
        ? { kind: "speech", transcript: "hello", provenance: "human-reviewed" }
        : { kind: "nonspeech", provenance: "human-reviewed" },
  }));
  const manifest = {
    version: 1,
    name: "acceptance fixture",
    prompt: "",
    cases,
  };
  const manifestSha256 = hash(JSON.stringify(manifest));
  const policy = DEFAULT_SPEECH_POLICY;
  const sourceSha256 = Object.fromEntries(sourceFiles.map((f) => [f, hash(f)]));
  const compiledSha256 = Object.fromEntries(
    sourceFiles.map((f) => [
      f.replace("src/", "").replace(/\.ts$/, ".js"),
      hash(`compiled:${f}`),
    ]),
  );
  const build = {
    version: 1,
    sourceSha256,
    compiledSha256,
    toolchain: {
      typescriptVersion: "6.0.3",
      tsconfigSha256: hash("tsconfig"),
      packageSha256: hash("package"),
      lockSha256: hash("lock"),
    },
  };
  const implementation = {
    version: 1,
    loader: "compiled",
    sourceSha256,
    compiledSha256,
    build,
    buildAssociationSha256: hash(stable(build)),
  };
  const results = cases.flatMap((c) =>
    [1, 2, 3].map((run) => ({
      caseId: c.id,
      sha256: c.sha256,
      run,
      split: c.split,
      label: c.label,
      tags: c.tags,
      familyId: c.familyId,
      speakerDeviceProfileId: c.speakerDeviceProfileId,
      status: "succeeded",
      text: c.label.kind === "speech" ? "hello" : "",
      reason: undefined as string | undefined,
      requests: 1,
      submittedAudioSeconds: 2,
      audioSeconds: 2,
      durationMs: 20,
      score: { scored: true },
      assessment: undefined as ReturnType<typeof assessment> | undefined,
      admission: undefined as
        | {
            kind: string;
            assessment: ReturnType<typeof assessment>;
            coverage: {
              pcmSha256: string;
              audioBytes: number;
              policyFingerprint: string;
            };
          }
        | undefined,
      stages: { assessmentMs: 10 },
    })),
  );
  const common = {
    version: 1,
    complete: true,
    manifestSha256,
    runs: 3,
    sourceSha256,
    compiledSha256,
    implementation,
    speechPolicy: policy,
    mode: "pipeline",
    passMode: "slow",
    prompt: "",
    model: "asr",
    policy: {} as { minSnippetSeconds?: number },
    force: false,
    maxRequests: 150,
    selection: { split: "holdout", batchSize: 25, batchIndex: 0 },
    results,
  };
  const baseline = {
    ...common,
    speechDetector: "off",
    speechMode: "off",
    results: results.map((row) => ({ ...row })),
  };
  baseline.results.forEach((row) =>
    Object.assign(row, { admission: { kind: "not_enforced", reason: "off" } }),
  );
  const candidate = {
    ...common,
    speechDetector: "production",
    speechMode: "enforce",
    results: deserialize(serialize(results)) as typeof results,
  };
  candidate.results.forEach((r) => {
    r.assessment = assessment(
      r.label.kind === "speech" ? "speech" : "non_speech",
    );
    r.admission = {
      kind: "assessed",
      assessment: r.assessment,
      coverage: {
        pcmSha256: hash(r.caseId),
        audioBytes: 384000,
        policyFingerprint: policy.policyFingerprint,
      },
    };
    if (r.label.kind === "nonspeech") {
      r.status = "skipped";
      r.reason = "non_speech";
      r.requests = 0;
      r.submittedAudioSeconds = 0;
    }
  });
  const detector = {
    ...common,
    providerRequests: 0,
    split: "holdout",
    phase: "slow",
    warmed: true,
    warmMs: 20,
    results: results.map((r) => ({
      ...r,
      assessment: assessment(
        r.label.kind === "speech" ? "speech" : "non_speech",
      ),
    })),
  };
  const review = {
    version: 1,
    manifestSha256,
    reviewedAt: "2026-10-13T12:00:00Z",
    holdoutUntouchedSinceFreeze: true,
    tuningFamilyIds: [] as string[],
  };
  const row = (phase: string, sequence: number, off = false) => ({
    phase,
    sequence,
    control: sequence % 2 === 0 ? "speech" : "nonspeech",
    durationMs: 100,
    assessment: off
      ? { kind: "off" }
      : assessment(sequence % 2 === 0 ? "speech" : "non_speech"),
  });
  const summarize = (rows: ReturnType<typeof row>[]) => ({
    attempts: rows.length,
    availability: rows.length ? 1 : null,
    p95Ms: rows.length ? 100 : null,
    allOutcomesP95Ms: rows.length ? 100 : null,
    unavailable: 0,
    queueFull: 0,
  });
  const measured = (rows: ReturnType<typeof row>[]) => ({
    ...summarize(rows),
    rows,
    phases: Object.fromEntries(
      ["fast", "slow"].map((p) => [
        p,
        summarize(rows.filter((r) => r.phase === p)),
      ]),
    ),
  });
  const schedule = Array.from({ length: 120 }, (_, second) => [
    { phase: "fast", at: second * 1000 },
    { phase: "slow", at: second * 1000 },
    ...[250, 500, 750].map((delta) => ({
      phase: "fast",
      at: second * 1000 + delta,
    })),
  ]).flat();
  const benchmark = {
    version: 1,
    complete: true,
    implementation,
    compiledSha256,
    speechPolicy: policy,
    limits: { cpu: 0.5, memoryBytes: 1073741824, source: "cgroup-v1" },
    nodeVersion: "v24.22.1",
    durationSeconds: 120,
    fastPerSecond: 4,
    slowPerSecond: 1,
    providerRequests: 0,
    warmed: true,
    coldStartMs: 20,
    steadyWorkerRestarts: 0,
    isolatedWorkerStarts: 10,
    fixtureSha256: {
      "yes-normal.wav": hash("speech-fixture"),
      "tune-tone.wav": hash("tone-fixture"),
    },
    baseline: {
      ...measured(schedule.map((job, i) => row(job.phase, i, true))),
      peakRss: 80000000,
      eventLoopP95Ms: 10,
    },
    steady: {
      ...measured(schedule.map((job, i) => row(job.phase, i))),
      peakRss: 80100000,
      eventLoopP95Ms: 11,
    },
    overheadBytes: 100000,
    addedEventLoopP95Ms: 1,
    buckets: [0.3, 2, 10, 60, 180].map((seconds) => {
      const rows = ["fast", "slow"].flatMap((phase) =>
        [0, 1, 2].flatMap((run) =>
          [0, 1].map((kind) => ({
            ...row(phase, run * 2 + kind),
            run,
            control: kind === 0 ? "speech" : "nonspeech",
          })),
        ),
      );
      return { seconds, rows, phases: measured(rows).phases };
    }),
    burst: {
      ...summarize(Array.from({ length: 10 }, (_, i) => row("slow", i))),
      attempts: 10,
      availability: 0.5,
      unavailable: 5,
      queueFull: 5,
      failOpen: true,
      rows: Array.from({ length: 10 }, (_, i) => ({
        ...row("slow", i),
        control: "nonspeech",
        assessment:
          i < 5
            ? assessment("non_speech")
            : {
                kind: "unavailable",
                reason: "queue_full",
                policyFingerprint: policy.policyFingerprint,
              },
      })),
    },
  };
  return { manifest, review, baseline, candidate, detector, benchmark };
}
function run(
  f: ReturnType<typeof fixture>,
  perfectFastBaseline = false,
  checkerRoot = compiled,
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
  try {
    for (const [k, v] of Object.entries(f))
      writeFileSync(path.join(dir, `${k}.json`), JSON.stringify(v));
    for (const k of ["baseline", "candidate"] as const) {
      const files: string[] = [];
      const ids = [...new Set(f[k].results.map((r) => r.caseId))].sort((a, b) =>
        a.localeCompare(b, "en"),
      );
      for (const phase of ["fast", "slow"])
        for (let index = 0; index < Math.ceil(ids.length / 25); index++) {
          const selectedCaseIds = ids.slice(index * 25, (index + 1) * 25);
          const rows = f[k].results.filter((r) =>
            selectedCaseIds.includes(r.caseId),
          );
          const file = path.join(dir, `${k}-${phase}-${index}.json`);
          writeFileSync(
            file,
            JSON.stringify(
              (() => {
                const report = {
                  ...f[k],
                  passMode: phase,
                  selection: {
                    ...f[k].selection,
                    batchIndex: index,
                    selectedCaseIds,
                    totalSelectedCases: ids.length,
                  },
                  results:
                    perfectFastBaseline && k === "baseline" && phase === "fast"
                      ? rows.map((r) => ({
                          ...r,
                          text: r.label.kind === "speech" ? "hello" : "",
                        }))
                      : rows,
                };
                const orderedCases = selectedCaseIds.map((id) =>
                  f.manifest.cases.find((c) => c.id === id),
                );
                return {
                  ...report,
                  summary: {
                    requests: report.results.reduce(
                      (n, r) => n + r.requests,
                      0,
                    ),
                    submittedAudioSeconds: report.results.reduce(
                      (n, r) => n + r.submittedAudioSeconds,
                      0,
                    ),
                    observedAudioSeconds: report.results.reduce(
                      (n, r) => n + r.audioSeconds,
                      0,
                    ),
                  },
                  runSha256: hash(
                    stable({
                      sourceSha256: report.sourceSha256,
                      cases: orderedCases,
                      runs: report.runs,
                      policy: report.policy,
                      prompt: report.prompt,
                      mode: report.mode,
                      passMode: phase,
                      speechDetector: report.speechDetector,
                      speechMode: report.speechMode,
                      implementation: report.implementation,
                    }),
                  ),
                };
              })(),
            ),
          );
          files.push(file);
        }
      writeFileSync(path.join(dir, `${k}-list.json`), JSON.stringify(files));
    }
    const out = path.join(dir, "scorecard.json");
    const proc = spawnSync(
      process.execPath,
      [
        path.join(checkerRoot, "scripts/speech-detection/check-acceptance.mjs"),
        "--manifest",
        path.join(dir, "manifest.json"),
        "--review-evidence",
        path.join(dir, "review.json"),
        "--detector",
        path.join(dir, "detector.json"),
        "--baseline",
        path.join(dir, "baseline-list.json"),
        "--candidate",
        path.join(dir, "candidate-list.json"),
        "--benchmark",
        path.join(dir, "benchmark.json"),
        "--output",
        out,
      ],
      {
        encoding: "utf8",
        cwd: checkerRoot,
        env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
      },
    );
    expect(proc.stderr).toBe("");
    return {
      status: proc.status,
      report: JSON.parse(readFileSync(out, "utf8")),
    };
  } finally {
    removeOwnedFixture(dir, "acceptance-");
  }
}
function expectRejectedEvidence(
  f: ReturnType<typeof fixture>,
  problem: string,
) {
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect([...result.report.failures, ...result.report.missing]).toContain(
    problem,
  );
  expect(result.report.missing).not.toContain(
    "missing or invalid evidence input",
  );
  return result;
}

test("complete matched evidence passes with attestation separate from verification", () => {
  const r = run(fixture());
  expect(r.report.benchmarkEvidence.problems).toEqual([]);
  expect(r.report.missing).toEqual([]);
  expect(r.report.failures).toEqual([]);
  expect(r.status).toBe(0);
  expect(r.report.status).toBe("pass");
  expect(r.report.attested.finalHumanReviewRequired).toBe(true);
});
test("accepts explicit off admission emitted by the runner", async () => {
  const f = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "acceptance-"));
  try {
    const produced = await runTranscriptionQualityCase({
      pcm: Buffer.alloc(384000),
      prompt: "",
      passMode: "slow",
      mode: "pipeline",
      force: false,
      policy: { noiseGate: { enabled: false } },
      production: {
        mode: "off",
        pcmFile: path.join(directory, "off.pcm"),
        wavFile: path.join(directory, "off.wav"),
        policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
      },
      transcribe: async () => ({ text: "hello" }),
    });
    expect(produced).toMatchObject({ status: "succeeded", requests: 1 });
    for (const row of f.baseline.results)
      Object.assign(row, { admission: produced.admission });
    const result = run(f);
    expect(result.report.benchmarkEvidence.problems).toEqual([]);
    expect(result.report.missing).toEqual([]);
    expect(result.report.failures).toEqual([]);
    expect(result.status).toBe(0);
  } finally {
    removeOwnedFixture(directory, "acceptance-");
  }
});
test("accepts benchmark measurements from the reviewed production runtime", () => {
  const f = fixture();
  f.benchmark.nodeVersion = "v24.22.1";
  const result = run(f);
  expect(result.report.benchmarkEvidence.problems).toEqual([]);
  expect(result.status).toBe(0);
});
test("accepts early positive speech evidence without requiring a full negative scan", () => {
  const f = fixture();
  for (const row of [
    f.candidate.results[0],
    f.detector.results[0],
    f.benchmark.steady.rows[0],
  ]) {
    if (!row.assessment || !("metrics" in row.assessment))
      throw new Error("Missing scored assessment");
    row.assessment.metrics.totalFrames = 100;
  }
  const result = run(f);
  expect(result.report.benchmarkEvidence.problems).toEqual([]);
  expect(result.report.missing).toEqual([]);
  expect(result.status).toBe(0);
});
test.each(["non_speech", "uncertain"])(
  "rejects partial negative %s evidence",
  (kind) => {
    const f = fixture();
    f.detector.results[300].assessment = assessment(kind);
    f.detector.results[300].assessment.metrics.totalFrames = 100;
    const result = run(f);
    expect(result.report.missing).toContain(
      "validated available detector assessments",
    );
    expect(result.status).not.toBe(0);
  },
);
test("rejects benchmark measurements from the historical runtime", () => {
  const f = fixture();
  f.benchmark.nodeVersion = "v24.15.0";
  const result = run(f);
  expect(result.report.benchmarkEvidence.problems).toContain(
    "missing or invalid raw benchmark measurements",
  );
  expect(result.status).not.toBe(0);
});
test.each([
  undefined,
  { kind: "not_enforced", reason: "forced" },
  { kind: "not_enforced", reason: "shadow" },
])(
  "rejects off evidence with missing or different admission %j",
  (admission) => {
    const f = fixture();
    Object.assign(f.baseline.results[0], { admission });
    const result = run(f);
    expect(result.report.missing).toContain("baseline validated rows");
    expect(result.status).not.toBe(0);
  },
);
test.each([
  "leak",
  "duplicate",
  "profiles",
  "speech",
  "rejection",
  "quality",
  "empty",
  "false-positive",
  "incomplete",
  "matching",
  "review",
  "budget",
  "missing-row",
  "bucket-budget",
  "nan-budget",
  "missing-benchmark",
  "insufficient-speech",
  "insufficient-quiet",
  "missing-provenance",
  "wrong-hash",
  "duplicate-row",
  "preflight",
  "unscored",
])("rejects %s even when other evidence looks perfect", (kind) => {
  const f = fixture();
  const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    leak: (f) => {
      f.review.tuningFamilyIds = ["family1"];
    },
    duplicate: (f) => {
      f.manifest.cases[1].sha256 = f.manifest.cases[0].sha256;
    },
    profiles: (f) => {
      f.manifest.cases.forEach((c) => (c.speakerDeviceProfileId = "one"));
    },
    speech: (f) => {
      f.detector.results[0].assessment.kind = "non_speech";
    },
    rejection: (f) => {
      f.detector.results.forEach((r) => (r.assessment.kind = "uncertain"));
    },
    quality: (f) => {
      f.candidate.results[0].text = "wrong";
    },
    empty: (f) => {
      f.candidate.results[0].text = "";
    },
    "false-positive": (f) => {
      f.candidate.results[300].text = "invented";
      f.candidate.results[300].status = "succeeded";
      f.candidate.results[300].reason = undefined;
      f.candidate.results[300].requests = 1;
      f.candidate.results[300].submittedAudioSeconds = 2;
      f.candidate.results[300].assessment = assessment("uncertain");
      f.candidate.results[300].admission!.assessment =
        f.candidate.results[300].assessment;
    },
    incomplete: (f) => {
      f.candidate.complete = false;
    },
    matching: (f) => {
      f.candidate.model = "other";
    },
    review: (f) => {
      f.review.holdoutUntouchedSinceFreeze = false;
    },
    budget: (f) => {
      f.benchmark.overheadBytes = 128 * 1024 * 1024;
      f.benchmark.steady.peakRss =
        f.benchmark.baseline.peakRss + f.benchmark.overheadBytes;
    },
    "phase-quality": (f) => {
      f.baseline.results[1].text = "wrong";
      f.candidate.results[0].text = "wrong";
    },
    "bucket-budget": (f) => {
      for (const row of f.benchmark.buckets[0].rows)
        if (row.phase === "fast") row.durationMs = 501;
      f.benchmark.buckets[0].phases.fast.p95Ms = 501;
      f.benchmark.buckets[0].phases.fast.allOutcomesP95Ms = 501;
    },
    "nan-budget": (f) => {
      f.benchmark.addedEventLoopP95Ms = Number.NaN;
    },
    "missing-benchmark": (f) => {
      f.benchmark.complete = false;
    },
    "insufficient-speech": (f) => {
      f.manifest.cases.splice(0, 1);
    },
    "insufficient-quiet": (f) => {
      f.manifest.cases[0].tags = [];
    },
    "missing-provenance": (f) => {
      f.manifest.cases[0].label.provenance = "synthetic";
    },
    "wrong-hash": (f) => {
      f.detector.results[0].sha256 = hash("different");
    },
    "duplicate-row": (f) => {
      f.candidate.results[0] = f.candidate.results[1];
    },
    preflight: (f) => {
      f.candidate.mode = "preflight";
    },
    unscored: (f) => {
      f.candidate.results[0].score.scored = false;
    },
    "missing-row": (f) => {
      f.candidate.results.pop();
    },
  };
  mutations[kind](f);

  const expectedProblems: Record<string, string> = {
    leak: "no tune/holdout family leakage",
    duplicate: "unique audio hashes",
    profiles: "five speech profiles",
    speech: "zero verified speech rejection",
    rejection: "at least half baseline-admitted nonspeech rejected",
    quality: "no wer regression",
    empty: "no speechEmpty regression",
    "false-positive": "no nonspeechFalsePositive regression",
    incomplete: "candidate complete matched pipeline reports",
    matching: "identical pipeline source/config/prompt/model/repetitions",
    review: "review evidence bound to manifest",
    budget: "detector overhead <128 MiB",
    "missing-row": "candidate exact case repetition coverage",
    "bucket-budget": "all duration buckets meet warm phase deadlines",
    "nan-budget": "complete consistent raw benchmark measurements",
    "missing-benchmark": "complete consistent raw benchmark measurements",
    "insufficient-speech": "minimum unique speech/nonspeech samples",
    "insufficient-quiet": "minimum quiet/short speech samples",
    "missing-provenance": "human-reviewed label provenance",
    "wrong-hash": "validated available detector assessments",
    "duplicate-row": "candidate exact case repetition coverage",
    preflight: "candidate complete matched pipeline reports",
    unscored: "candidate validated rows",
  };
  const result = expectRejectedEvidence(f, expectedProblems[kind]);
  if (kind === "budget" || kind === "bucket-budget")
    expect(result.report.benchmarkEvidence.problems).toEqual([]);
});
test("zero baseline reports undefined relative change and money as null", () => {
  const f = fixture();
  for (const side of [f.baseline, f.candidate]) {
    side.policy = { minSnippetSeconds: 3 };
    for (const r of side.results) {
      r.status = "skipped";
      r.reason = "minimum_duration";
      r.text = "";
      r.requests = 0;
      r.submittedAudioSeconds = 0;
      r.assessment = undefined;
      r.admission = undefined;
    }
  }
  const r = run(f);
  expect(r.status).not.toBe(0);
  expect(r.report.status).toBe("incomplete");
  expect(r.report.missing).toContain("baseline-admitted nonspeech denominator");
  expect(r.report.scorecard.providerRequests.relativeChange).toBeNull();
  expect(r.report.costUsd).toBeNull();
});

test("one phase regression cannot hide behind another phase improvement", () => {
  const f = fixture();
  f.baseline.results[0].text = "wrong";
  f.baseline.results[1].text = "wrong";
  f.candidate.results[0].text = "wrong";
  const result = run(f, true);
  expect(result.status).not.toBe(0);
  expect(result.report.failures).toContain("fast no wer regression");
  expect(result.report.scorecard.wer.absoluteChange).toBe(0);
});

test("comparison report retains matched pipeline and detector provenance without prompt content", () => {
  const f = fixture();
  f.baseline.prompt = "private prompt fixture";
  f.candidate.prompt = "private prompt fixture";
  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.report.provenance.speechPolicy).toEqual(DEFAULT_SPEECH_POLICY);
  for (const mode of ["baseline", "candidate"] as const) {
    const reports = result.report.provenance.pipeline[mode];
    expect(reports).toHaveLength(12);
    expect(reports[0]).toMatchObject({
      sourceSha256: f[mode].sourceSha256,
      model: "asr",
      mode: "pipeline",
      passMode: "fast",
      promptSha256: hash("private prompt fixture"),
      policySha256: hash(JSON.stringify(f[mode].policy)),
      speechDetector: f[mode].speechDetector,
      speechMode: f[mode].speechMode,
      selection: { split: "holdout", batchSize: 25, batchIndex: 0 },
    });
  }
  expect(JSON.stringify(result.report)).not.toContain("private prompt fixture");
});

test.each([
  "raw-rows",
  "phase-count",
  "control-count",
  "edited-availability",
  "rss-summary",
  "event-loop-summary",
  "latency-summary",
  "burst-rows",
  "bucket-repeats",
  "missing-compiled",
  "compiled-mismatch",
  "partial-source",
  "build-source-mismatch",
  "source-loader",
  "zero-sdk-success",
  "excess-phase-work",
  "submitted-seconds",
  "paid-skip",
  "budget",
  "row-policy",
])("rejects inconsistent acceptance evidence: %s", (kind) => {
  const f = fixture();
  const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "raw-rows": (f) => {
      Reflect.deleteProperty(f.benchmark.steady, "rows");
    },
    "phase-count": (f) => {
      f.benchmark.steady.rows[0].phase = "slow";
    },
    "control-count": (f) => {
      f.benchmark.steady.rows[0].control = "nonspeech";
    },
    "edited-availability": (f) => {
      f.benchmark.steady.rows[0].assessment = {
        kind: "unavailable",
        reason: "timeout",
        policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
      };
    },
    "rss-summary": (f) => {
      f.benchmark.overheadBytes = 1;
    },
    "event-loop-summary": (f) => {
      f.benchmark.addedEventLoopP95Ms = 0;
    },
    "latency-summary": (f) => {
      f.benchmark.steady.phases.fast.p95Ms = 1;
    },
    "burst-rows": (f) => {
      Reflect.deleteProperty(f.benchmark.burst, "rows");
    },
    "bucket-repeats": (f) => {
      f.benchmark.buckets[0].rows.pop();
    },
    "missing-compiled": (f) => {
      Reflect.deleteProperty(f.detector, "compiledSha256");
    },
    "compiled-mismatch": (f) => {
      f.detector.compiledSha256 = {
        ...f.detector.compiledSha256,
        "services/speechDetectionService.js": hash("old"),
      };
    },
    "partial-source": (f) => {
      f.candidate.sourceSha256 = { source: hash("fake") };
    },
    "build-source-mismatch": (f) => {
      f.candidate.implementation = deserialize(
        serialize(f.candidate.implementation),
      );
      f.candidate.implementation.build.sourceSha256[
        "src/services/speechDetectionService.ts"
      ] = hash("old");
    },
    "source-loader": (f) => {
      f.candidate.implementation = {
        ...f.candidate.implementation,
        loader: "source",
      };
    },
    "zero-sdk-success": (f) => {
      f.candidate.results[0].requests = 0;
      f.candidate.results[0].submittedAudioSeconds = 0;
    },
    "excess-phase-work": (f) => {
      f.candidate.results[0].requests = 3;
      f.candidate.results[0].submittedAudioSeconds = 6;
    },
    "submitted-seconds": (f) => {
      f.candidate.results[0].submittedAudioSeconds = 99;
    },
    "paid-skip": (f) => {
      f.candidate.results[300].requests = 1;
      f.candidate.results[300].submittedAudioSeconds = 2;
    },
    budget: (f) => {
      f.candidate.maxRequests = 1;
    },
    "row-policy": (f) => {
      f.candidate.results[0].assessment!.policyFingerprint =
        hash("other policy");
    },
  };
  mutations[kind](f);

  const expectedProblems: Record<string, string> = {
    "raw-rows": "complete consistent raw benchmark measurements",
    "phase-count": "complete consistent raw benchmark measurements",
    "control-count": "complete consistent raw benchmark measurements",
    "edited-availability": "complete consistent raw benchmark measurements",
    "rss-summary": "complete consistent raw benchmark measurements",
    "event-loop-summary": "complete consistent raw benchmark measurements",
    "latency-summary": "complete consistent raw benchmark measurements",
    "burst-rows": "complete consistent raw benchmark measurements",
    "bucket-repeats": "complete consistent raw benchmark measurements",
    "missing-compiled":
      "complete matched source/build/compiled implementation identity",
    "compiled-mismatch":
      "complete matched source/build/compiled implementation identity",
    "partial-source":
      "complete matched source/build/compiled implementation identity",
    "build-source-mismatch":
      "complete matched source/build/compiled implementation identity",
    "source-loader":
      "complete matched source/build/compiled implementation identity",
    "zero-sdk-success": "candidate validated rows",
    "excess-phase-work": "candidate validated rows",
    "submitted-seconds": "candidate validated rows",
    "paid-skip": "candidate validated rows",
    "row-policy": "candidate validated rows",
    budget: "candidate provider budget and summary accounting",
  };
  expectRejectedEvidence(f, expectedProblems[kind]);
});

test("candidate rejection of already-empty verified speech fails both pipeline phase gates", () => {
  const f = fixture();
  f.baseline.results[0].text = "";
  const r = f.candidate.results[0];
  r.text = "";
  r.status = "skipped";
  r.reason = "non_speech";
  r.requests = 0;
  r.submittedAudioSeconds = 0;
  r.assessment = assessment("non_speech");
  r.admission!.assessment = r.assessment;
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect(result.report.failures).toContain(
    "zero verified pipeline speech rejection",
  );
  expect(result.report.detector.pipelineSpeechRejection).toMatchObject({
    numerator: 2,
    denominator: 600,
  });
  expect(
    result.report.detector.pipelineSpeechRejectionByPhase.fast.numerator,
  ).toBe(1);
  expect(
    result.report.detector.pipelineSpeechRejectionByPhase.slow.numerator,
  ).toBe(1);
  expect(
    result.report.detector.pipelineSpeechRejectionByGroup.quiet.numerator,
  ).toBe(2);
});

test(
  "positive acceptance works from an owned source-only checkout without dist",
  async () => {
    const checkout = mkdtempSync(
      path.join(os.tmpdir(), "vad-build-contract-acceptance-source-"),
    );
    try {
      copyTranscriptionSourceCheckout(root, checkout);
      expect(existsSync(path.join(checkout, "dist"))).toBe(false);
      const owned = await prepareTranscriptionAcceptanceFixture(checkout, root);
      let result: ReturnType<typeof run>;
      try {
        result = run(fixture(), false, owned);
      } finally {
        removeOwnedFixture(owned, "vad-build-contract-");
      }
      expect(result.report.missing).toEqual([]);
      expect(result.status).toBe(0);
      expect(result.report.status).toBe("pass");
      expect(existsSync(path.join(checkout, "dist"))).toBe(false);
    } finally {
      removeOwnedFixture(checkout, "vad-build-contract-");
    }
  },
  TRANSCRIPTION_FIXTURE_SETUP_TIMEOUT_MS + 60000,
);
