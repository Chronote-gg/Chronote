import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { decodeTranscriptionEvalAudio } from "../../src/evals/transcriptionQualityEval";
import { convertTranscriptionPcmToWav } from "../../src/services/transcriptionAudioService";
import type { TranscriptionCorpusCase } from "../../src/evals/transcriptionCorpus";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((value) => value !== "--speech"))
    throw new Error("Only --speech is supported");
  const root = path.resolve(".cache/transcription-eval");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "synthetic-"));
  const cases: TranscriptionCorpusCase[] = [];
  const add = async (
    id: string,
    pcm: Buffer,
    split: "tune" | "holdout",
    tags: string[],
    transcript?: string,
  ) => {
    const pcmFile = path.join(directory, `${id}.pcm`);
    const file = `${id}.wav`;
    await fs.writeFile(pcmFile, pcm);
    await convertTranscriptionPcmToWav(pcmFile, path.join(directory, file));
    await fs.unlink(pcmFile);
    const sha256 = createHash("sha256")
      .update(await fs.readFile(path.join(directory, file)))
      .digest("hex");
    cases.push({
      id,
      file,
      sha256,
      split,
      tags,
      label:
        transcript === undefined
          ? {
              kind: "nonspeech",
              provenance: "synthetic",
              notes: "Generated signal contains no speech.",
            }
          : {
              kind: "speech",
              transcript,
              provenance: "synthetic",
              notes:
                "Reference is the independent TTS input. Human recording quality is not established.",
            },
    });
  };
  await addSignalControls(add);
  let synthesisRequests = 0;
  if (args.includes("--speech")) {
    const { createOpenAIClient } =
      await import("../../src/services/openaiClient");
    const client = createOpenAIClient({ disableTracing: true }).withOptions({
      maxRetries: 0,
      timeout: 60000,
    });
    const phrases = [
      { id: "yes", text: "Yes.", split: "tune" as const },
      { id: "vrchat", text: "VRChat.", split: "tune" as const },
      { id: "workshop", text: "The Workshop.", split: "tune" as const },
      {
        id: "sentence",
        text: "Let's meet tomorrow to discuss the event schedule.",
        split: "tune" as const,
      },
      { id: "no", text: "No.", split: "holdout" as const },
      { id: "discord", text: "Discord.", split: "holdout" as const },
      { id: "makers", text: "The Makers.", split: "holdout" as const },
      {
        id: "plan",
        text: "Please send the revised plan before Friday.",
        split: "holdout" as const,
      },
    ];
    for (const phrase of phrases) {
      synthesisRequests++;
      const response = await client.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "coral",
        input: phrase.text,
        response_format: "wav",
      });
      const source = path.join(directory, `${phrase.id}-tts.wav`);
      const pcmFile = path.join(directory, `${phrase.id}-source.pcm`);
      await fs.writeFile(source, Buffer.from(await response.arrayBuffer()));
      await decodeTranscriptionEvalAudio(source, pcmFile, 30);
      const pcm = await fs.readFile(pcmFile);
      await addSpeechVariants(add, phrase, pcm);
      const opus = path.join(directory, `${phrase.id}.ogg`);
      await new Promise<void>((resolve, reject) =>
        ffmpeg(source)
          .audioCodec("libopus")
          .audioBitrate("32k")
          .on("end", () => resolve())
          .on("error", reject)
          .save(opus),
      );
      await decodeTranscriptionEvalAudio(opus, pcmFile, 30);
      await add(
        `${phrase.id}-opus`,
        await fs.readFile(pcmFile),
        phrase.split,
        ["speech", "opus", "short-or-sentence"],
        phrase.text,
      );
      await fs.unlink(pcmFile);
    }
  }
  const manifest = path.join(directory, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        version: 1,
        name: "synthetic-transcription-controls-v1",
        prompt:
          "Dictionary terms: VRChat, Discord, The Workshop, The Makers. Context: planning a community event.",
        cases,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(directory, "generation.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        synthesisRequests,
        synthesisModel: synthesisRequests ? "gpt-4o-mini-tts" : null,
        voice: synthesisRequests ? "coral" : null,
        note: "Synthetic controls only. No production recordings were accessed or replayed.",
      },
      null,
      2,
    ),
  );
  console.log(
    `Created ${cases.length} synthetic cases using ${synthesisRequests} synthesis requests.`,
  );
  console.log(`Manifest: ${manifest}`);
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Corpus preparation failed",
  );
  process.exitCode = 1;
});

type AddCase = (
  id: string,
  pcm: Buffer,
  split: "tune" | "holdout",
  tags: string[],
  transcript?: string,
) => Promise<void>;

async function addSignalControls(add: AddCase) {
  let seed = 1701;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (const split of ["tune", "holdout"] as const) {
    const seconds = split === "tune" ? 2 : 3;
    for (const signal of ["silence", "noise", "tone", "click"] as const) {
      const pcm = signalPcm(signal, split, seconds, noise);
      await add(`${split}-${signal}`, pcm, split, [signal, "nonspeech"]);
    }
  }
}

async function addSpeechVariants(
  add: AddCase,
  phrase: { id: string; text: string; split: "tune" | "holdout" },
  pcm: Buffer,
) {
  let peak = 1;
  for (let index = 0; index < pcm.length; index += 2)
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(index)));
  for (const [variant, dbfs] of [
    ["normal", -20],
    ["quiet", -52],
  ] as const) {
    const scaled = Buffer.from(pcm);
    const gain = (32768 * Math.pow(10, dbfs / 20)) / peak;
    for (let index = 0; index < pcm.length; index += 2)
      scaled.writeInt16LE(Math.round(pcm.readInt16LE(index) * gain), index);
    await add(
      `${phrase.id}-${variant}`,
      scaled,
      phrase.split,
      [
        "speech",
        variant,
        phrase.text.split(/\s+/).length <= 2 ? "short-speech" : "sentence",
        phrase.id === "workshop" || phrase.id === "makers"
          ? "dictionary-phrase"
          : "control",
      ],
      phrase.text,
    );
  }
}

function signalPcm(
  signal: "silence" | "noise" | "tone" | "click",
  split: "tune" | "holdout",
  seconds: number,
  noise: () => number,
) {
  const pcm = Buffer.alloc(48000 * 4 * seconds);
  for (let frame = 0; frame < pcm.length / 4; frame++) {
    const amplitude =
      signal === "noise"
        ? noise() * 50
        : signal === "tone"
          ? Math.sin(
              (frame / 48000) * 2 * Math.PI * (split === "tune" ? 440 : 880),
            ) * 4000
          : signal === "click" && frame === 24000
            ? 8000
            : 0;
    pcm.writeInt16LE(Math.round(amplitude), frame * 4);
    pcm.writeInt16LE(Math.round(amplitude), frame * 4 + 2);
  }
  return pcm;
}
