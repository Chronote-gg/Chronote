import { ledgerWriterRuntimeSchema } from "./ledgerWriterRuntime";
import { HISTORY_WRITER_VERSION } from "./historyWriterBoundary";
import { z } from "zod";
export const normalPurchaseWriterWitnessSchema = ledgerWriterRuntimeSchema
  .extend({
    writerVersion: z.literal(HISTORY_WRITER_VERSION),
    invoiceId: z.string().min(1),
  })
  .strict();
export type NormalPurchaseWriterWitness = z.infer<
  typeof normalPurchaseWriterWitnessSchema
>;
