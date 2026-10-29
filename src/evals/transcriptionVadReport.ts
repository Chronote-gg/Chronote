import { z } from "zod";
import type { TranscriptionCorpusCase } from "./transcriptionCorpus";

export const transcriptionVadReportSchema = z
  .object({
    version: z.literal(1),
    detector: z.string().min(1),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeVersion: z.string(),
    numpyVersion: z.string(),
    parameters: z
      .object({
        threshold: z.number().gt(0).lt(1),
        minFrames: z.number().int().positive(),
        normalizeDbfs: z.number().nullable(),
        maxGain: z.number().positive(),
      })
      .strict(),
    cases: z.array(
      z
        .object({
          id: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          shouldTranscribe: z.boolean(),
          peakSpeechProbability: z.number().min(0).max(1),
          maxConsecutiveSpeechFrames: z.number().int().nonnegative(),
          gain: z.number().positive(),
          durationMs: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length)
      ctx.addIssue({ code: "custom", message: "VAD case IDs must be unique" });
  });
export type TranscriptionVadDecision = z.infer<
  typeof transcriptionVadReportSchema
>["cases"][number];

export const validateVadCase = (
  item: TranscriptionCorpusCase,
  decisions: TranscriptionVadDecision[],
) => {
  const decision = decisions.find((candidate) => candidate.id === item.id);
  if (!decision || decision.sha256 !== item.sha256)
    throw new Error(`Missing or stale VAD decision for ${item.id}`);
  return decision;
};
