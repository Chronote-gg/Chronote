import { z } from "zod";
const alignedByte = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine(
    (value) => value % 4 === 0,
    "PCM byte boundary must be frame aligned",
  );
export const pcmSpanSchema = z
  .object({
    sourceId: z.string().regex(/^(user|bot):[a-zA-Z0-9_-]+$/),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    startByte: alignedByte,
    endByte: alignedByte,
  })
  .strict()
  .refine((span) => span.endByte > span.startByte, "PCM span must be nonempty");
export type PcmSpan = z.infer<typeof pcmSpanSchema>;
export const pcmSpansSchema = z
  .array(pcmSpanSchema)
  .superRefine((spans, context) => {
    for (let i = 1; i < spans.length; i++) {
      const previous = spans[i - 1],
        current = spans[i];
      if (
        current.sourceId < previous.sourceId ||
        (current.sourceId === previous.sourceId &&
          (current.sequence < previous.sequence ||
            (current.sequence === previous.sequence &&
              current.startByte <= previous.endByte)))
      )
        context.addIssue({
          code: "custom",
          message: "PCM spans must be ordered, disjoint and coalesced",
          path: [i],
        });
    }
  });
export const transcriptCorrespondenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pcm"), spans: pcmSpansSchema }).strict(),
  z.object({ kind: z.literal("text_only") }).strict(),
]);
export type TranscriptCorrespondence = z.infer<
  typeof transcriptCorrespondenceSchema
>;
