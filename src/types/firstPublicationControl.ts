import { z } from "zod";
export const firstPublicationPinsSchema = z.record(
  z.string(),
  z
    .object({
      authorities: z.array(z.string()).min(1).max(25),
      settled: z.array(z.string()).max(25),
    })
    .strict(),
);
export const firstPublicationControlFields = {
  publicationCompatibleImages: z
    .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    .max(1024)
    .optional(),
  publicationProtocol: z.literal(1).optional(),
  publicationPins: firstPublicationPinsSchema.optional(),
  publicationTransition: z
    .object({ runToken: z.string(), images: z.array(z.string()) })
    .strict()
    .optional(),
};
