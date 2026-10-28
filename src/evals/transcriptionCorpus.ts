import { z } from "zod";

const provenance = z.enum(["human-reviewed", "synthetic"]);
const label = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("speech"),
      transcript: z.string().trim().min(1),
      provenance,
      notes: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("nonspeech"),
      provenance,
      notes: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("unreviewed"), notes: z.string().optional() })
    .strict(),
]);

export const transcriptionPolicySchema = z
  .object({
    suppressionEnabled: z.boolean().optional(),
    promptEchoEnabled: z.boolean().optional(),
    voteEnabled: z.boolean().optional(),
    suppressionHardSilenceDbfs: z.number().min(-120).max(0).optional(),
    suppressionRateMaxSeconds: z.number().positive().optional(),
    suppressionRateMinWords: z.number().int().nonnegative().optional(),
    suppressionRateMinSyllables: z.number().int().nonnegative().optional(),
    suppressionRateMaxSyllablesPerSecond: z.number().positive().optional(),
    minSnippetSeconds: z.number().nonnegative().optional(),
    noiseGate: z
      .object({
        enabled: z.boolean().optional(),
        windowMs: z.number().positive().optional(),
        peakDbfs: z.number().min(-120).max(0).optional(),
        minActiveWindows: z.number().int().nonnegative().optional(),
        minPeakAboveNoiseDb: z.number().nonnegative().optional(),
        applyToFast: z.boolean().optional(),
        applyToSlow: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TranscriptionEvalPolicy = z.infer<typeof transcriptionPolicySchema>;

export const transcriptionCorpusSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    prompt: z.string().default(""),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            file: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            split: z.enum(["tune", "holdout"]),
            tags: z.array(z.string()).default([]),
            label,
            familyId: z.string().trim().min(1).optional(),
            speakerDeviceProfileId: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length)
      ctx.addIssue({ code: "custom", message: "Case IDs must be unique" });
  });
export type TranscriptionCorpus = z.infer<typeof transcriptionCorpusSchema>;
export type TranscriptionCorpusCase = TranscriptionCorpus["cases"][number];
export const referenceForCase = (
  item: TranscriptionCorpusCase,
): string | undefined =>
  item.label.kind === "speech"
    ? item.label.transcript
    : item.label.kind === "nonspeech"
      ? ""
      : undefined;

export function selectCorpusBatch<T extends { id: string }>(
  cases: T[],
  size: number,
  index: number,
): T[] {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 25 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index * size >= cases.length
  )
    throw new Error("Invalid corpus batch selection");
  return [...cases]
    .sort((a, b) => a.id.localeCompare(b.id, "en"))
    .slice(index * size, (index + 1) * size);
}
