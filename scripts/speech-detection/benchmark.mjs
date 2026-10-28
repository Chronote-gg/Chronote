import {
  assessmentStats as stats,
  assessmentPhases as phases,
} from "./assessment-stats.mjs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseArgs } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  artifactWorkspace,
  hash,
  implementationProvenance,
  requireCompiled,
  root,
  writeJson,
} from "./evidence.mjs";
const { values } = parseArgs({
  options: {
    "duration-seconds": { type: "string", default: "120" },
    "fast-per-second": { type: "string", default: "4" },
    "slow-per-second": { type: "string", default: "1" },
    output: { type: "string" },
    "artifact-dir": { type: "string" },
  },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function processTreeRss(pid = process.pid) {
  if (process.platform !== "linux") return null;
  let total = 0;
  const pending = [pid];
  try {
    while (pending.length) {
      const current = pending.pop();
      const status = readFileSync(`/proc/${current}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!rss) return null;
      total += Number(rss[1]) * 1024;
      const children = readFileSync(
        `/proc/${current}/task/${current}/children`,
        "utf8",
      ).trim();
      if (children) pending.push(...children.split(/\s+/).map(Number));
    }
    return total;
  } catch {
    return null;
  }
}
function audio(seconds, pcm) {
  const samples = Math.round(seconds * 16000),
    wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples * 2; i++) wav[44 + i] = pcm[i % pcm.length];
  return wav;
}
async function limits() {
  try {
    const cpu = (await readFile("/sys/fs/cgroup/cpu.max", "utf8"))
      .trim()
      .split(" ")
      .map(Number);
    const memoryBytes = Number(
      (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(),
    );
    return { cpu: cpu[0] / cpu[1], memoryBytes, source: "cgroup-v2" };
  } catch {
    try {
      const quota = Number(
        await readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8"),
      );
      const period = Number(
        await readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"),
      );
      const memoryBytes = Number(
        await readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8"),
      );
      return { cpu: quota / period, memoryBytes, source: "cgroup-v1" };
    } catch {
      return { cpu: null, memoryBytes: null, source: "unavailable" };
    }
  }
}
async function measureBucketPhase(
  rows,
  bucketDetector,
  seconds,
  phase,
  assess,
  sources,
  countStart,
) {
  const { getSpeechDetector, shutdownSpeechDetector } = requireCompiled(
    "./speechDetectionService.js",
  );
  for (let run = 0; run < 3; run++) {
    for (let kind = 0; kind < 2; kind++) {
      const result = await assess(
        bucketDetector,
        audio(seconds, sources[kind]),
        phase,
      );
      rows.push({
        ...result,
        run,
        control: kind === 0 ? "speech" : "nonspeech",
      });
      if (result.assessment.kind === "unavailable") {
        await shutdownSpeechDetector();
        bucketDetector = getSpeechDetector();
        await bucketDetector.warm();
        countStart();
      }
    }
  }
}
async function measureBuckets(buckets, assess, sources, countStart) {
  const { getSpeechDetector, shutdownSpeechDetector } = requireCompiled(
    "./speechDetectionService.js",
  );
  for (const seconds of [0.3, 2, 10, 60, 180]) {
    const rows = [];
    for (const phase of ["fast", "slow"]) {
      await shutdownSpeechDetector();
      let bucketDetector = getSpeechDetector();
      await bucketDetector.warm();
      countStart();
      await measureBucketPhase(
        rows,
        bucketDetector,
        seconds,
        phase,
        assess,
        sources,
        countStart,
      );
    }
    buckets.push({ seconds, phases: phases(rows), rows });
  }
}
async function main() {
  const durationSeconds = Number(values["duration-seconds"]),
    fastPerSecond = Number(values["fast-per-second"]),
    slowPerSecond = Number(values["slow-per-second"]);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 600 ||
    ![fastPerSecond, slowPerSecond].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 20,
    )
  )
    throw Error("invalid_options");
  const implementation = await implementationProvenance();
  const workspace = await artifactWorkspace(
    values.output,
    values["artifact-dir"],
  );
  const { getSpeechDetector, shutdownSpeechDetector } = requireCompiled(
      "./speechDetectionService.js",
    ),
    { DEFAULT_SPEECH_POLICY } = requireCompiled("./speechDetectionPolicy.js");
  const sources = ["yes-normal.wav", "tune-tone.wav"].map((file) => {
    const r = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path.join(root, "test/fixtures/speech-detection", file),
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.status !== 0 || !r.stdout.length)
      throw Error("fixture_decode_failed");
    return r.stdout;
  });
  const two = sources.map((pcm) => audio(2, pcm));
  const assess = async (detector, wav, phase) => {
    const start = performance.now();
    const assessment = detector
      ? await detector.assess(wav, phase)
      : { kind: "off" };
    return { phase, durationMs: performance.now() - start, assessment };
  };
  async function load(detector) {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    let peakRss = processTreeRss();
    const memory = setInterval(() => {
      const rss = processTreeRss();
      peakRss =
        peakRss === null || rss === null ? null : Math.max(peakRss, rss);
    }, 20);
    const start = performance.now(),
      jobs = [];
    let index = 0;
    const schedule = [];
    for (const [phase, rate] of [
      ["fast", fastPerSecond],
      ["slow", slowPerSecond],
    ])
      for (let i = 0; i < durationSeconds * rate; i++)
        schedule.push({ at: (1000 * i) / rate, phase });
    schedule.sort((a, b) => a.at - b.at);
    for (const job of schedule) {
      await sleep(Math.max(0, start + job.at - performance.now()));
      const sequence = index++;
      jobs.push(
        assess(detector, two[sequence % 2], job.phase).then((row) => ({
          ...row,
          sequence,
          control: sequence % 2 === 0 ? "speech" : "nonspeech",
        })),
      );
    }
    const rows = await Promise.all(jobs);
    clearInterval(memory);
    delay.disable();
    return {
      ...stats(rows),
      phases: phases(rows),
      peakRss,
      eventLoopP95Ms: delay.percentile(95) / 1e6,
      rows,
    };
  }
  try {
    const baseline = await load(undefined),
      detector = getSpeechDetector(),
      coldStart = performance.now(),
      warmed = await detector.warm(),
      coldStartMs = performance.now() - coldStart;
    const steady = await load(detector),
      buckets = [];
    let isolatedWorkerStarts = 0;
    const { metricsRegistry } = requireCompiled("../metrics.js");
    const restartMetric = await metricsRegistry
      .getSingleMetric("chronote_speech_detection_worker_restarts_total")
      .get();
    const steadyWorkerRestarts = restartMetric.values.reduce(
      (sum, item) => sum + item.value,
      0,
    );
    await measureBuckets(
      buckets,
      assess,
      sources,
      () => isolatedWorkerStarts++,
    );
    // A fresh worker avoids mistaking deadline cooldown for the overflow exercise.
    await shutdownSpeechDetector();
    const burstDetector = getSpeechDetector();
    await burstDetector.warm();
    const burstRows = await Promise.all(
      Array.from({ length: 10 }, (_, sequence) =>
        assess(burstDetector, two[1], "slow").then((row) => ({
          ...row,
          sequence,
          control: "nonspeech",
        })),
      ),
    );
    const burst = {
      ...stats(burstRows),
      failOpen: burstRows
        .filter((r) => r.assessment.kind === "unavailable")
        .every((r) => r.assessment.reason !== undefined),
      rows: burstRows,
    };
    const report = {
      version: 1,
      complete: true,
      nodeVersion: process.version,
      limits: await limits(),
      compiledSha256: implementation.compiledSha256,
      implementation,
      speechPolicy: DEFAULT_SPEECH_POLICY,
      durationSeconds,
      fastPerSecond,
      slowPerSecond,
      warmed,
      coldStartMs,
      baseline,
      steady,
      buckets,
      burst,
      overheadBytes:
        steady.peakRss === null || baseline.peakRss === null
          ? null
          : steady.peakRss - baseline.peakRss,
      addedEventLoopP95Ms: steady.eventLoopP95Ms - baseline.eventLoopP95Ms,
      providerRequests: 0,
      fixtureSha256: Object.fromEntries(
        await Promise.all(
          ["yes-normal.wav", "tune-tone.wav"].map(async (file) => [
            file,
            hash(
              await readFile(
                path.join(root, "test/fixtures/speech-detection", file),
              ),
            ),
          ]),
        ),
      ),
      steadyWorkerRestarts,
      isolatedWorkerStarts,
      memoryMethod:
        "20ms Linux /proc process-tree RSS sampling, including detector child; steady peak minus detector-off tree peak before bucket runs; unavailable measurements are null",
      bucketMethod:
        "fresh readiness per phase and after any unavailability; cold recovery time excluded from assessment latency",
    };
    await writeJson(workspace.output, report);
    console.log(
      JSON.stringify({
        output: workspace.output,
        limits: report.limits,
        coldStartMs,
        availability: steady.availability,
        overheadBytes: report.overheadBytes,
        addedEventLoopP95Ms: report.addedEventLoopP95Ms,
      }),
    );
  } finally {
    await shutdownSpeechDetector();
    await workspace.cleanup();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ category: "benchmark_failed" }));
  process.exitCode = 1;
});
