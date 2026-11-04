import { z } from "zod";
import { pcmSpansSchema } from "./transcriptCorrespondence";

export const speechRejectionSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.literal("enforce"),
    decision: z.literal("non_speech"),
    phase: z.enum(["fast", "slow"]),
    decidedAt: z.iso.datetime(),
    snippetTimestamp: z.number().finite(),
    userId: z.string().min(1),
    pcmSha256: z.string().regex(/^[a-f0-9]{64}$/),
    audioBytes: z
      .number()
      .int()
      .positive()
      .max(48000 * 4 * 180),
    policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    spans: pcmSpansSchema.refine((spans) => spans.length > 0),
    outcome: z.enum([
      "request_skipped",
      "final_omission",
      "transcript_present",
    ]),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.spans.some((s) => s.sourceId !== `user:${receipt.userId}`) ||
      receipt.spans.reduce((n, s) => n + s.endByte - s.startByte, 0) !==
        receipt.audioBytes
    )
      ctx.addIssue({
        code: "custom",
        message: "Rejection input differs from PCM correspondence",
      });
  });
export type SpeechRejection = z.infer<typeof speechRejectionSchema>;
