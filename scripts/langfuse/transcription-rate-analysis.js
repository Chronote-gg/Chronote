#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const RATE_SUPPRESSION_THRESHOLDS = {
  rateMaxSeconds: 3,
  minWords: 4,
  minSyllables: 8,
  maxSyllablesPerSecond: 7,
};
// Keep in sync with TRANSCRIPTION_RATE_* defaults in src/constants.ts.

const parseArgs = (argv) => {
  const args = [...argv];
  const outputIndex = args.indexOf("--output");
  let outputPath = null;
  if (outputIndex !== -1) {
    outputPath = args[outputIndex + 1] ?? null;
    args.splice(outputIndex, 2);
  }
  return { files: args, outputPath };
};

const percentiles = (values, points) => {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const result = {};
  for (const point of points) {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.round(point * (sorted.length - 1))),
    );
    result[point] = sorted[index];
  }
  return result;
};

const formatNumber = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(value))
    return "n/a";
  return value.toFixed(digits);
};

const loadSyllable = async () => {
  const mod = await import("syllable");
  const counter = mod.syllable ?? mod.default ?? mod;
  if (typeof counter !== "function") {
    throw new Error("Failed to load syllable counter.");
  }
  return counter;
};

const countWords = (text) => {
  if (!text) return 0;
  // Keep in sync with src/utils/text.ts countWords.
  return text.trim().split(/\s+/).filter(Boolean).length;
};

const pickOutputText = (output) => {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && typeof output.content === "string") {
    return output.content;
  }
  return "";
};

const bucketByAudioSeconds = (audioSeconds) => {
  if (audioSeconds <= 3) return "<=3s";
  if (audioSeconds <= 10) return "3-10s";
  return ">10s";
};

const buildReport = (summary) => {
  const lines = [];
  lines.push("# Transcription rate analysis");
  lines.push("");
  lines.push(`Run date: ${summary.runDate}`);
  lines.push(`Source files: ${summary.fileCount}`);
  lines.push(`Trace count: ${summary.traceCount}`);
  lines.push(`Analyzed entries: ${summary.entryCount}`);
  lines.push("");
  lines.push("## SPS percentiles");
  lines.push("");
  for (const [bucket, data] of Object.entries(summary.buckets)) {
    lines.push(
      `- ${bucket}: count=${data.count}, p50=${data.p50}, p90=${data.p90}, p95=${data.p95}, p99=${data.p99}`,
    );
  }
  lines.push("");
  lines.push("## Outlier samples");
  lines.push("");
  lines.push(
    `Threshold: audioSeconds <= ${RATE_SUPPRESSION_THRESHOLDS.rateMaxSeconds}, syllables >= ${RATE_SUPPRESSION_THRESHOLDS.minSyllables}, words >= ${RATE_SUPPRESSION_THRESHOLDS.minWords}, sps >= ${RATE_SUPPRESSION_THRESHOLDS.maxSyllablesPerSecond}`,
  );
  lines.push("");
  if (summary.outliers.length === 0) {
    lines.push("No outliers found.");
  } else {
    for (const outlier of summary.outliers) {
      lines.push(
        `- ${outlier.id} meeting=${outlier.meetingId} audioSeconds=${formatNumber(
          outlier.audioSeconds,
          2,
        )} words=${outlier.wordCount} syllables=${outlier.syllableCount} sps=${formatNumber(
          outlier.sps,
          2,
        )} quietAudio=${outlier.quietAudio} suppressed=${outlier.suppressed} text="${outlier.text}"`,
      );
    }
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "SPS is syllables per second, computed with the syllable library. Output text is taken from trace output when present.",
  );
  return lines.join("\n");
};

const main = async () => {
  const { files, outputPath } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    throw new Error("Provide one or more trace JSON files.");
  }

  const syllable = await loadSyllable();
  const entries = [];

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const payload = JSON.parse(raw);
    const traces = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    if (traces.length === 0) continue;
    for (const trace of traces) {
      if (!trace || trace.name !== "transcription") continue;
      const text = pickOutputText(trace.output).trim();
      if (!text) continue;
      const audioSeconds = Number(trace.metadata?.audioSeconds ?? 0);
      if (!audioSeconds || audioSeconds <= 0) continue;
      const wordCount = countWords(text);
      const syllableCount = syllable(text);
      const sps = syllableCount / audioSeconds;
      const wps = wordCount / audioSeconds;
      entries.push({
        id: trace.id,
        meetingId: trace.metadata?.meetingId ?? "unknown",
        audioSeconds,
        wordCount,
        syllableCount,
        wps,
        sps,
        quietAudio: Boolean(trace.metadata?.quietAudio),
        suppressed: Boolean(trace.metadata?.suppressed),
        text,
      });
    }
  }

  const buckets = {
    "<=3s": [],
    "3-10s": [],
    ">10s": [],
  };

  for (const entry of entries) {
    buckets[bucketByAudioSeconds(entry.audioSeconds)].push(entry.sps);
  }

  const bucketStats = Object.entries(buckets).reduce(
    (acc, [bucket, values]) => {
      const p = percentiles(values, [0.5, 0.9, 0.95, 0.99]);
      acc[bucket] = {
        count: values.length,
        p50: formatNumber(p[0.5]),
        p90: formatNumber(p[0.9]),
        p95: formatNumber(p[0.95]),
        p99: formatNumber(p[0.99]),
      };
      return acc;
    },
    {},
  );

  const outliers = entries
    .filter(
      (entry) =>
        entry.audioSeconds <= RATE_SUPPRESSION_THRESHOLDS.rateMaxSeconds &&
        entry.syllableCount >= RATE_SUPPRESSION_THRESHOLDS.minSyllables &&
        entry.wordCount >= RATE_SUPPRESSION_THRESHOLDS.minWords &&
        entry.sps >= RATE_SUPPRESSION_THRESHOLDS.maxSyllablesPerSecond,
    )
    .sort((a, b) => b.sps - a.sps)
    .slice(0, 20);

  const summary = {
    runDate: new Date().toISOString().slice(0, 10),
    fileCount: files.length,
    traceCount: entries.length,
    entryCount: entries.length,
    buckets: bucketStats,
    outliers,
  };

  const report = buildReport(summary);
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, report, "utf8");
  }

  process.stdout.write(report + "\n");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
