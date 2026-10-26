import { z } from "zod";

const timingBase = z.object({
  notesVersion: z.literal(1),
  path: z.enum(["live", "recovery"]),
  firstAcknowledgedAt: z.iso.datetime({ offset: true }),
});

export const notesDeliveryTimingSchema = z
  .discriminatedUnion("kind", [
    timingBase.extend({ kind: z.literal("first") }).strict(),
    timingBase
      .extend({
        kind: z.literal("complete"),
        completeAcknowledgedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  ])
  .refine(
    (timing) =>
      timing.kind === "first" ||
      Date.parse(timing.completeAcknowledgedAt) >=
        Date.parse(timing.firstAcknowledgedAt),
    "Complete acknowledgement precedes first acknowledgement",
  );

export type NotesDeliveryTiming = z.infer<typeof notesDeliveryTimingSchema>;
