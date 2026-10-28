import { z } from "zod";
import {
  assessmentStats,
  assessmentPhases as phases,
} from "./assessment-stats.mjs";
const nonnegative = z.number().finite().nonnegative();
const integer = nonnegative.int();
const metric = z
  .object({
    peakSpeechProbability: z.number().min(0).max(1),
    maxConsecutiveSpeechFrames: integer,
    scannedFrames: integer.positive(),
    totalFrames: integer.positive(),
    gain: z.number().positive().max(100),
  })
  .strict()
  .refine(
    (m) =>
      m.scannedFrames <= m.totalFrames &&
      m.maxConsecutiveSpeechFrames <= m.scannedFrames,
  );
export function assessmentSchema(fingerprint) {
  const scored = (kind) =>
    z
      .object({
        kind: z.literal(kind),
        policyFingerprint: z.literal(fingerprint),
        metrics: metric,
      })
      .strict()
      .refine(
        (assessment) =>
          kind === "speech" ||
          assessment.metrics.scannedFrames === assessment.metrics.totalFrames,
      );
  return z
    .union([
      scored("speech"),
      scored("non_speech"),
      scored("uncertain"),
      z
        .object({
          kind: z.literal("unavailable"),
          policyFingerprint: z.literal(fingerprint),
          reason: z.enum([
            "not_ready",
            "queue_full",
            "timeout",
            "worker_error",
            "invalid_input",
            "invalid_output",
            "asset_error",
            "channel_cancellation",
            "shutdown",
          ]),
        })
        .strict(),
    ])
    .refine((a) =>
      a.kind === "speech"
        ? a.metrics.peakSpeechProbability >= 0.5 &&
          a.metrics.maxConsecutiveSpeechFrames >= 2
        : a.kind === "non_speech"
          ? a.metrics.peakSpeechProbability < 0.35 &&
            a.metrics.maxConsecutiveSpeechFrames < 2
          : true,
    );
}
const sameStats = (declared, actual) =>
  [
    "attempts",
    "availability",
    "p95Ms",
    "allOutcomesP95Ms",
    "unavailable",
    "queueFull",
  ].every((k) => declared?.[k] === actual[k]);
const samePhases = (declared, actual) =>
  ["fast", "slow"].every((p) => sameStats(declared?.[p], actual[p]));
export function inspectBenchmark(input, fingerprint) {
  const row = z
    .object({
      phase: z.enum(["fast", "slow"]),
      durationMs: nonnegative,
      assessment: z.union([
        assessmentSchema(fingerprint),
        z.object({ kind: z.literal("off") }).strict(),
      ]),
      sequence: integer.optional(),
      control: z.enum(["speech", "nonspeech"]).optional(),
      run: integer.max(2).optional(),
    })
    .passthrough();
  const measured = z
    .object({
      rows: z.array(row),
      peakRss: integer.positive(),
      eventLoopP95Ms: nonnegative,
    })
    .passthrough();
  const parsed = z
    .object({
      version: z.literal(1),
      complete: z.literal(true),
      limits: z.object({
        cpu: z.literal(0.5),
        memoryBytes: z.literal(1073741824),
        source: z.enum(["cgroup-v1", "cgroup-v2"]),
      }),
      nodeVersion: z.literal("v24.22.1"),
      durationSeconds: integer.min(1).max(600),
      fastPerSecond: z.literal(4),
      slowPerSecond: z.literal(1),
      providerRequests: z.literal(0),
      warmed: z.literal(true),
      coldStartMs: nonnegative,
      steadyWorkerRestarts: integer,
      isolatedWorkerStarts: integer,
      baseline: measured,
      steady: measured,
      buckets: z
        .array(
          z.object({ seconds: z.number(), rows: z.array(row) }).passthrough(),
        )
        .length(5),
      burst: z.object({ rows: z.array(row) }).passthrough(),
      overheadBytes: z.number().finite(),
      addedEventLoopP95Ms: z.number().finite(),
    })
    .passthrough()
    .safeParse(input);
  if (!parsed.success)
    return {
      valid: false,
      recomputed: null,
      problems: ["missing or invalid raw benchmark measurements"],
    };
  const b = parsed.data,
    problems = [];
  const check = (ok, name) => {
    if (!ok) problems.push(name);
  };
  const steady = {
    ...assessmentStats(b.steady.rows),
    phases: phases(b.steady.rows),
  };
  const baseline = {
    ...assessmentStats(b.baseline.rows),
    phases: phases(b.baseline.rows),
  };
  const buckets = b.buckets.map((bucket) => ({
    seconds: bucket.seconds,
    phases: phases(bucket.rows),
  }));
  const burst = {
    ...assessmentStats(b.burst.rows),
    failOpen: b.burst.rows
      .filter((r) => r.assessment.kind === "unavailable")
      .every((r) => r.assessment.reason !== undefined),
  };
  const recomputed = {
    baseline,
    steady,
    buckets,
    burst,
    overheadBytes: b.steady.peakRss - b.baseline.peakRss,
    addedEventLoopP95Ms: b.steady.eventLoopP95Ms - b.baseline.eventLoopP95Ms,
  };
  const schedule = [];
  for (const [phase, rate] of [
    ["fast", b.fastPerSecond],
    ["slow", b.slowPerSecond],
  ])
    for (let i = 0; i < b.durationSeconds * rate; i++)
      schedule.push({ at: (1000 * i) / rate, phase });
  schedule.sort((a, b) => a.at - b.at);
  for (const [name, measurement] of [
    ["baseline", b.baseline],
    ["steady", b.steady],
  ]) {
    check(
      measurement.rows.length === schedule.length &&
        measurement.rows.every(
          (r, i) =>
            r.phase === schedule[i]?.phase &&
            r.sequence === i &&
            r.control === (i % 2 === 0 ? "speech" : "nonspeech") &&
            (name === "baseline"
              ? r.assessment.kind === "off"
              : r.assessment.kind !== "off"),
        ),
      `${name} exact phase/control schedule`,
    );
    const stats = name === "baseline" ? baseline : steady;
    check(
      sameStats(measurement, stats) &&
        samePhases(measurement.phases, stats.phases),
      `${name} summary matches raw rows`,
    );
  }
  check(
    [0.3, 2, 10, 60, 180].every(
      (s) => b.buckets.filter((r) => r.seconds === s).length === 1,
    ),
    "exact duration buckets",
  );
  for (const bucket of b.buckets) {
    const keys = new Set(
      bucket.rows.map((r) => `${r.phase}|${r.run}|${r.control}`),
    );
    check(
      bucket.rows.length === 12 &&
        keys.size === 12 &&
        ["fast", "slow"].every((phase) =>
          [0, 1, 2].every((run) =>
            ["speech", "nonspeech"].every((control) =>
              keys.has(`${phase}|${run}|${control}`),
            ),
          ),
        ) &&
        bucket.rows.every((r) => r.assessment.kind !== "off"),
      `${bucket.seconds} exact phase/control repetitions`,
    );
    check(
      samePhases(bucket.phases, phases(bucket.rows)),
      `${bucket.seconds} summary matches raw rows`,
    );
  }
  check(
    b.burst.rows.length === 10 &&
      b.burst.rows.every(
        (r, i) =>
          r.phase === "slow" &&
          r.sequence === i &&
          r.control === "nonspeech" &&
          r.assessment.kind !== "off",
      ),
    "burst exact slow nonspeech schedule",
  );
  check(
    sameStats(b.burst, burst) && b.burst.failOpen === burst.failOpen,
    "burst summary matches raw rows",
  );
  check(
    b.overheadBytes === recomputed.overheadBytes,
    "RSS overhead matches sampled peaks",
  );
  check(
    b.addedEventLoopP95Ms === recomputed.addedEventLoopP95Ms,
    "event loop overhead matches baseline/steady",
  );
  const fixture = z
    .object({
      "yes-normal.wav": z.string().regex(/^[a-f0-9]{64}$/),
      "tune-tone.wav": z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .safeParse(b.fixtureSha256);
  check(fixture.success, "complete control fixture hashes");
  return { valid: problems.length === 0, recomputed, problems };
}
export function pipelineRowSemantics(row, report, fingerprint) {
  if (!validRowAccounting(row)) return false;
  const gateSkip =
    row.status === "skipped" &&
    ["minimum_duration", "noise_gate"].includes(row.reason);
  if (gateSkip) return validGateSkip(row, report);
  const admission = pipelineAdmission(row, report, fingerprint);
  if (admission === "invalid") return false;
  if (admission === "non_speech")
    return (
      row.status === "skipped" &&
      row.reason === "non_speech" &&
      row.requests === 0 &&
      row.text === ""
    );
  const maximum = maximumPipelineRequests(report);
  return (
    row.status === "succeeded" &&
    row.reason === undefined &&
    row.requests >= 1 &&
    row.requests <= maximum
  );
}

function pipelineAdmission(row, report, fingerprint) {
  if (report.speechDetector === "production") {
    const assessment = assessmentSchema(fingerprint).safeParse(row.assessment);
    if (
      !assessment.success ||
      row.admission?.kind !== "assessed" ||
      JSON.stringify(row.admission.assessment) !==
        JSON.stringify(row.assessment) ||
      row.admission.coverage?.policyFingerprint !== fingerprint ||
      !/^[a-f0-9]{64}$/.test(row.admission.coverage?.pcmSha256) ||
      row.admission.coverage?.audioBytes !==
        Math.round(row.audioSeconds * 48000 * 4)
    )
      return "invalid";
    return assessment.data.kind === "non_speech" ? "non_speech" : "admitted";
  } else if (
    row.assessment ||
    !z
      .object({
        kind: z.literal("not_enforced"),
        reason: z.literal("off"),
      })
      .strict()
      .safeParse(row.admission).success
  )
    return "invalid";
  return "admitted";
}

function validGateSkip(row, report) {
  return (
    row.requests === 0 &&
    row.text === "" &&
    !row.assessment &&
    !row.admission &&
    (row.reason !== "minimum_duration" ||
      row.audioSeconds <= (report.policy?.minSnippetSeconds ?? 0.3))
  );
}

function validRowAccounting(row) {
  return !(
    !Number.isInteger(row.requests) ||
    row.requests < 0 ||
    !Number.isFinite(row.audioSeconds) ||
    row.audioSeconds <= 0 ||
    row.submittedAudioSeconds !== row.requests * row.audioSeconds ||
    typeof row.text !== "string"
  );
}

function maximumPipelineRequests(report) {
  return report.passMode === "slow" &&
    report.policy?.voteEnabled !== false &&
    report.prompt.trim()
    ? 2
    : 1;
}
