import {
  collectTranscriptionImplementation,
  stableJson,
} from "./transcriptionImplementation";
import { DEFAULT_SPEECH_POLICY } from "../services/speechDetectionPolicy";
import {
  getSpeechDetector,
  shutdownSpeechDetector,
} from "../services/speechDetectionService";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import type OpenAI from "openai";
import { BYTES_PER_SAMPLE, CHANNELS, RECORD_SAMPLE_RATE } from "../constants";
import {
  referenceForCase,
  selectCorpusBatch,
  transcriptionCorpusSchema,
  transcriptionPolicySchema,
  type TranscriptionCorpusCase,
} from "./transcriptionCorpus";
import {
  runTranscriptionQualityCase,
  TranscriptionBudgetExhausted,
  type TranscriptionQualityRun,
} from "./transcriptionQualityCase";
import { summarizeTranscriptionScores } from "./transcriptionMetrics";
import {
  transcriptionVadReportSchema,
  validateVadCase,
} from "./transcriptionVadReport";

const flag = (args: string[], name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return value;
};
const numberFlag = (
  args: string[],
  name: string,
  fallback: number,
  maximum: number,
) => {
  const value = Number(flag(args, name) ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
};

export function decodeTranscriptionEvalAudio(
  source: string,
  destination: string,
  maxSeconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(source);
    if (path.extname(source).toLowerCase() === ".pcm")
      command.inputOptions([
        "-f s16le",
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ]);
    // Decode one extra second so an oversized clip is detected instead of silently truncated.
    command
      .duration(maxSeconds + 1)
      .outputOptions([
        "-f s16le",
        "-c:a pcm_s16le",
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ])
      .on("end", () => resolve())
      .on("error", reject)
      .save(destination);
  });
}

type CorpusRun = TranscriptionQualityRun & {
  stages: TranscriptionQualityRun["stages"] & { decodeMs: number };
  caseId: string;
  run: number;
  split: TranscriptionCorpusCase["split"];
  tags: string[];
  label: TranscriptionCorpusCase["label"];
  sha256: string;
  familyId?: string;
  speakerDeviceProfileId?: string;
};

export function summarizeQualityRuns(results: CorpusRun[]) {
  return {
    attemptedRuns: results.length,
    succeededRuns: results.filter((item) => item.status === "succeeded").length,
    skippedRuns: results.filter((item) => item.status === "skipped").length,
    eligibleRuns: results.filter((item) => item.status === "eligible").length,
    failedRuns: results.filter((item) => item.status === "failed").length,
    requests: results.reduce((sum, item) => sum + item.requests, 0),
    avoidedPrimaryRequests: results.filter((item) => item.status === "skipped")
      .length,
    submittedAudioSeconds: results.reduce(
      (sum, item) => sum + item.submittedAudioSeconds,
      0,
    ),
    observedAudioSeconds: results.reduce(
      (sum, item) => sum + item.audioSeconds,
      0,
    ),
    totalDurationMs: results.reduce((sum, item) => sum + item.durationMs, 0),
    ...summarizeTranscriptionScores(results.map((item) => item.score)),
  };
}

export async function runTranscriptionQualityEval(args: string[]) {
  const {
    manifestPath,
    corpus,
    mode,
    passMode,
    runs,
    maxRequests,
    maxSeconds,
    split,
    policy,
    prompt,
    force,
    selected,
    batchSize,
    batchIndex,
    cases,
    speechDetector,
    speechMode,
    vadReport,
    cacheRoot,
    output,
  } = await readQualityOptions(args);
  await fs.mkdir(cacheRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(cacheRoot, "run-"));
  if (
    path.dirname(path.resolve(tempDir)) !== cacheRoot ||
    !path.basename(tempDir).startsWith("run-")
  )
    throw new Error("Invalid eval temporary directory");
  const results: CorpusRun[] = [];
  let client: OpenAI | undefined;
  let model = flag(args, "--model");
  const startedAt = new Date().toISOString();
  const detector =
    speechDetector === "production" ? getSpeechDetector() : undefined;
  let warmMs: number | null = null;
  let warmed: boolean | null = null;
  try {
    // Refuse missing/stale build before decoding or any paid provider setup.
    const implementation = await collectTranscriptionImplementation();
    const sourceSha256 = implementation.sourceSha256;
    if (detector) {
      const start = performance.now();
      warmed = await detector.warm();
      warmMs = performance.now() - start;
    }
    // Validate and decode the entire corpus before spending any provider requests.
    const prepared: {
      item: TranscriptionCorpusCase;
      pcm: Buffer;
      pcmFile: string;
      wavFile: string;
      decodeMs: number;
    }[] = [];
    for (const item of cases) {
      const { pcm, pcmFile, wavFile, decodeMs } = await prepareCorpusAudio(
        item,
        manifestPath,
        tempDir,
        maxSeconds,
      );
      prepared.push({ item, pcm, pcmFile, wavFile, decodeMs });
    }
    if (mode !== "preflight") {
      const { createOpenAIClient } = await import("../services/openaiClient");
      const { getModelChoice } = await import("../services/modelFactory");
      model ??= getModelChoice("transcription").model;
      // SDK retries are disabled so the request budget counts actual attempts.
      client = createOpenAIClient({ disableTracing: true }).withOptions({
        maxRetries: 0,
        timeout: 60000,
      });
    }
    const transcriber = createQualityTranscriber(client, model, maxRequests);
    const runCases = async () => {
      outer: for (const { item, pcm, pcmFile, wavFile, decodeMs } of prepared) {
        for (let run = 1; run <= runs; run++) {
          const result = await runTranscriptionQualityCase({
            pcm,
            prompt,
            passMode,
            mode,
            policy,
            force,
            production: {
              detector,
              mode: detector ? speechMode : "off",
              pcmFile,
              wavFile,
              policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
            },
            reference: referenceForCase(item),
            vad: vadReport ? validateVadCase(item, vadReport.cases) : undefined,
            transcribe: transcriber(wavFile),
          });
          results.push({
            ...result,
            stages: {
              ...result.stages,
              decodeMs,
            },
            caseId: item.id,
            run,
            split: item.split,
            tags: item.tags,
            label: item.label,
            sha256: item.sha256,
            familyId: item.familyId,
            speakerDeviceProfileId: item.speakerDeviceProfileId,
          });
          console.log(
            `${item.id} run ${run}: ${result.status}, ${result.requests} requests`,
          );
          if (result.reason === "budget_exhausted") break outer;
        }
      }
    };
    await runCases();
    const saveReport = async () => {
      const summary = summarizeQualityRuns(results);
      const { bySplit, byProvenance, byTag } = summarizeQualityGroups(results);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(
        output,
        JSON.stringify(
          {
            version: 1,
            corpus: corpus.name,
            manifestSha256: createHash("sha256")
              .update(await fs.readFile(manifestPath))
              .digest("hex"),
            startedAt,
            nodeVersion: process.version,
            sourceSha256,
            compiledSha256: implementation.compiledSha256,
            implementation,
            runSha256: createHash("sha256")
              .update(
                stableJson({
                  sourceSha256,
                  cases,
                  runs,
                  policy,
                  prompt,
                  mode,
                  passMode,
                  speechDetector,
                  speechMode: detector ? speechMode : "off",
                  implementation,
                }),
              )
              .digest("hex"),
            selection: {
              split: split ?? null,
              batchSize,
              batchIndex,
              selectedCaseIds: cases.map((item) => item.id),
              totalSelectedCases: selected.length,
            },
            speechDetector,
            speechMode: detector ? speechMode : "off",
            speechPolicy: DEFAULT_SPEECH_POLICY,
            warmMs,
            warmed,
            finishedAt: new Date().toISOString(),
            mode,
            passMode,
            model: model ?? null,
            prompt,
            policy,
            force,
            vadReport: vadReport ? { ...vadReport, cases: undefined } : null,
            runs,
            maxRequests,
            complete:
              results.length === cases.length * runs &&
              !results.some((item) => item.status === "failed"),
            requestedRuns: cases.length * runs,
            costUsd: null,
            costNote:
              "Usage is recorded for each response. Failed requests and dollar cost are unpriced.",
            summary,
            bySplit,
            byProvenance,
            byTag,
            results,
          },
          (_, value) =>
            typeof value === "number" && !Number.isFinite(value)
              ? String(value)
              : value,
          2,
        ),
      );
      console.log(JSON.stringify(summary, null, 2));
      console.log(`Local results: ${output}`);
      if (
        results.length !== cases.length * runs ||
        results.some((item) => item.status === "failed")
      )
        process.exitCode = 1;
      return output;
    };
    return await saveReport();
  } finally {
    if (detector) await shutdownSpeechDetector();
    // Delete only the temporary directory created by this invocation.
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function prepareCorpusAudio(
  item: TranscriptionCorpusCase,
  manifestPath: string,
  tempDir: string,
  maxSeconds: number,
) {
  const file = path.resolve(path.dirname(manifestPath), item.file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
    throw new Error(`Invalid or oversized audio for ${item.id}`);
  const digest = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
  if (digest !== item.sha256)
    throw new Error(
      `Audio hash changed for ${item.id}; review its label again`,
    );
  const pcmFile = path.join(tempDir, `${item.id}.pcm`);
  const wavFile = path.join(tempDir, `${item.id}.wav`);
  const decodeStarted = performance.now();
  await decodeTranscriptionEvalAudio(file, pcmFile, maxSeconds);
  const decodeMs = performance.now() - decodeStarted;
  const pcm = await fs.readFile(pcmFile);
  const seconds =
    pcm.length / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  if (!seconds || seconds > maxSeconds)
    throw new Error(
      `Audio duration for ${item.id} must be between 0 and ${maxSeconds} seconds`,
    );
  return { pcm, pcmFile, wavFile, seconds, decodeMs };
}

function qualityModes(args: string[]): {
  mode: "provider" | "pipeline" | "preflight";
  passMode: "fast" | "slow";
} {
  const mode = flag(args, "--mode") ?? "pipeline";
  if (mode !== "provider" && mode !== "pipeline" && mode !== "preflight")
    throw new Error("--mode must be provider, pipeline, or preflight");
  const passMode = flag(args, "--pass-mode") ?? "slow";
  if (passMode !== "fast" && passMode !== "slow")
    throw new Error("--pass-mode must be fast or slow");
  return { mode, passMode };
}

function speechOptions(
  args: string[],
  mode: string,
): { speechDetector: "off" | "production"; speechMode: "shadow" | "enforce" } {
  const speechDetector = flag(args, "--speech-detector") ?? "off";
  if (speechDetector !== "off" && speechDetector !== "production")
    throw new Error("Invalid speech detector");
  const speechMode = flag(args, "--speech-mode") ?? "enforce";
  if (speechMode !== "shadow" && speechMode !== "enforce")
    throw new Error("Invalid speech mode");
  if (speechDetector === "off" && flag(args, "--speech-mode"))
    throw new Error("Speech mode requires production detector");
  if (
    speechDetector === "production" &&
    (flag(args, "--vad-report") || mode === "provider")
  )
    throw new Error(
      "Production detector conflicts with external VAD or provider-only mode",
    );
  return { speechDetector, speechMode };
}

function artifactPaths(args: string[], mode: string, passMode: string) {
  const cacheRoot = path.resolve(
    flag(args, "--artifact-dir") ?? ".cache/transcription-eval",
  );
  const output = path.resolve(
    flag(args, "--output") ??
      path.join(cacheRoot, `${Date.now()}-${mode}-${passMode}.json`),
  );
  const relativeOutput = path.relative(cacheRoot, output);
  if (
    !relativeOutput ||
    relativeOutput.startsWith("..") ||
    path.isAbsolute(relativeOutput)
  )
    throw new Error(
      "Corpus results must remain inside the selected artifact directory",
    );
  return { cacheRoot, output };
}

async function readQualityOptions(args: string[]) {
  validateQualityArguments(args);
  const manifestPath = path.resolve(flag(args, "--manifest") ?? "");
  const corpus = transcriptionCorpusSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
  );
  const { mode, passMode } = qualityModes(args);
  const runs = numberFlag(args, "--runs", 3, 20);
  const maxRequests = numberFlag(args, "--max-requests", 100, 200);
  const maxSeconds = numberFlag(args, "--max-clip-seconds", 30, 60);
  const split = flag(args, "--split");
  if (split && split !== "tune" && split !== "holdout")
    throw new Error("--split must be tune or holdout");
  const policyFile = flag(args, "--policy");
  const policy = transcriptionPolicySchema.parse(
    policyFile
      ? JSON.parse(await fs.readFile(path.resolve(policyFile), "utf8"))
      : {},
  );
  const promptFile = flag(args, "--prompt-file");
  const prompt = promptFile
    ? await fs.readFile(path.resolve(promptFile), "utf8")
    : corpus.prompt;
  const force = args.includes("--force");
  const selected = corpus.cases.filter(
    (item) => !split || item.split === split,
  );
  const batchSize = numberFlag(args, "--batch-size", 25, 25);
  const batchIndex = Number(flag(args, "--batch-index") ?? 0);
  const cases = selectCorpusBatch(selected, batchSize, batchIndex);
  const { speechDetector, speechMode } = speechOptions(args, mode);
  const vadFile = flag(args, "--vad-report");
  if (vadFile && mode === "provider")
    throw new Error("Provider baseline does not accept a VAD gate");
  const vadReport = vadFile
    ? transcriptionVadReportSchema.parse(
        JSON.parse(await fs.readFile(path.resolve(vadFile), "utf8")),
      )
    : undefined;
  if (vadReport)
    cases.forEach((item) => validateVadCase(item, vadReport.cases));
  if (!cases.length || cases.length > 200)
    throw new Error("Select between 1 and 200 corpus cases");
  const { cacheRoot, output } = artifactPaths(args, mode, passMode);
  return {
    manifestPath,
    corpus,
    mode,
    passMode,
    runs,
    maxRequests,
    maxSeconds,
    split,
    policy,
    prompt,
    force,
    selected,
    batchSize,
    batchIndex,
    cases,
    speechDetector,
    speechMode,
    vadReport,
    cacheRoot,
    output,
  };
}

function summarizeQualityGroups(results: CorpusRun[]) {
  const bySplit = Object.fromEntries(
    ["tune", "holdout"].map((value) => [
      value,
      summarizeQualityRuns(results.filter((item) => item.split === value)),
    ]),
  );
  const byProvenance = Object.fromEntries(
    ["human-reviewed", "synthetic", "unreviewed"].map((value) => [
      value,
      summarizeQualityRuns(
        results.filter(
          (item) =>
            (item.label.kind === "unreviewed"
              ? "unreviewed"
              : item.label.provenance) === value,
        ),
      ),
    ]),
  );
  const byTag = Object.fromEntries(
    [...new Set(results.flatMap((item) => item.tags))].map((tag) => [
      tag,
      summarizeQualityRuns(results.filter((item) => item.tags.includes(tag))),
    ]),
  );
  return { bySplit, byProvenance, byTag };
}

function createQualityTranscriber(
  client: OpenAI | undefined,
  model: string | undefined,
  maxRequests: number,
) {
  let requests = 0;
  return (wavFile: string) => async (requestPrompt?: string) => {
    if (requests >= maxRequests)
      throw new TranscriptionBudgetExhausted("Request budget exhausted");
    requests++;
    const response = await client!.audio.transcriptions.create({
      file: createReadStream(wavFile),
      model: model!,
      language: "en",
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      ...(requestPrompt ? { prompt: requestPrompt } : {}),
    });
    return {
      text: response.text,
      logprobs: response.logprobs ?? [],
      usage: response.usage,
    };
  };
}

function validateQualityArguments(args: string[]) {
  const allowed = new Set([
    "--manifest",
    "--mode",
    "--runs",
    "--pass-mode",
    "--max-requests",
    "--max-clip-seconds",
    "--split",
    "--policy",
    "--prompt-file",
    "--model",
    "--output",
    "--force",
    "--vad-report",
    "--artifact-dir",
    "--speech-detector",
    "--speech-mode",
    "--batch-size",
    "--batch-index",
  ]);
  for (const argument of args.filter((item) => item.startsWith("--")))
    if (!allowed.has(argument))
      throw new Error(`Unknown corpus option ${argument}`);
}
