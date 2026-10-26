import { z } from "zod";
import { introOfferIdSchema } from "./basicIntroOffers";
import { ledgerWriterRuntimeSchema } from "./ledgerWriterRuntime";
export const introOfferAuthoritySchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    mode: z.enum(["live", "test"]),
    offerId: introOfferIdSchema,
    accountId: z.string().min(1),
    coverageRevision: z.string().min(1),
    boundaryRevision: z.string().min(1),
    writerImageDigest: ledgerWriterRuntimeSchema.shape.imageDigest,
  })
  .strict();
export type IntroOfferAuthority = z.infer<typeof introOfferAuthoritySchema>;
