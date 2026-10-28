import process from "node:process";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactWorkspace,
  implementationProvenance,
  hash,
  requireCompiled,
  writeJson,
} from "./evidence.mjs";
const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    split: { type: "string", default: "holdout" },
    runs: { type: "string", default: "3" },
    output: { type: "string" },
    "artifact-dir": { type: "string" },
    "max-clip-seconds": { type: "string", default: "60" },
    "pass-mode": { type: "string", default: "slow" },
  },
});
async function main() {
  const runs = Number(values.runs),
    maxSeconds = Number(values["max-clip-seconds"]),
    phase = values["pass-mode"];
  if (
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 20 ||
    !Number.isInteger(maxSeconds) ||
    maxSeconds < 1 ||
    maxSeconds > 60 ||
    !["tune", "holdout"].includes(values.split) ||
    !["fast", "slow"].includes(phase)
  )
    throw Error("invalid_options");
  const { transcriptionCorpusSchema } = requireCompiled(
    "./../evals/transcriptionCorpus.js",
  );
  const { prepareCorpusAudio } = requireCompiled(
    "./../evals/transcriptionQualityEval.js",
  );
  const { convertTranscriptionPcmToWav } = requireCompiled(
    "./transcriptionAudioService.js",
  );
  const { getSpeechDetector, shutdownSpeechDetector } = requireCompiled(
    "./speechDetectionService.js",
  );
  const { DEFAULT_SPEECH_POLICY } = requireCompiled(
    "./speechDetectionPolicy.js",
  );
  const manifestPath = path.resolve(values.manifest),
    bytes = await readFile(manifestPath);
  const corpus = transcriptionCorpusSchema.parse(JSON.parse(bytes));
  const cases = corpus.cases
    .filter((c) => c.split === values.split)
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (!cases.length) throw Error("empty_split");
  const implementation = await implementationProvenance();
  const workspace = await artifactWorkspace(
    values.output,
    values["artifact-dir"],
  );
  const detector = getSpeechDetector(),
    results = [];
  try {
    const start = performance.now(),
      warmed = await detector.warm(),
      warmMs = performance.now() - start;
    for (const item of cases) {
      const prepared = await prepareCorpusAudio(
        item,
        manifestPath,
        workspace.temp,
        maxSeconds,
      );
      await convertTranscriptionPcmToWav(prepared.pcmFile, prepared.wavFile);
      const wav = new Uint8Array(await readFile(prepared.wavFile));
      for (let run = 1; run <= runs; run++) {
        const start = performance.now(),
          assessment = await detector.assess(wav, phase);
        results.push({
          caseId: item.id,
          sha256: item.sha256,
          label: item.label,
          tags: item.tags,
          familyId: item.familyId,
          speakerDeviceProfileId: item.speakerDeviceProfileId,
          run,
          assessment,
          durationMs: performance.now() - start,
          audioSeconds: prepared.seconds,
        });
      }
    }
    const complete =
      results.length === cases.length * runs &&
      results.every((r) => r.assessment.kind !== "unavailable");
    await writeJson(workspace.output, {
      version: 1,
      complete,
      manifestSha256: hash(bytes),
      compiledSha256: implementation.compiledSha256,
      implementation,
      nodeVersion: process.version,
      split: values.split,
      phase,
      runs,
      warmed,
      warmMs,
      speechPolicy: DEFAULT_SPEECH_POLICY,
      providerRequests: 0,
      results,
    });
    if (!complete) process.exitCode = 1;
    console.log(
      JSON.stringify({
        complete,
        cases: cases.length,
        attempts: results.length,
        providerRequests: 0,
        output: workspace.output,
      }),
    );
  } finally {
    await shutdownSpeechDetector();
    await workspace.cleanup();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ category: "detector_evaluation_failed" }));
  process.exitCode = 1;
});
