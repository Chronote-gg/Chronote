import { z } from "zod";
export const ledgerWriterRuntimeSchema = z
  .object({
    taskArn: z.string().regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:task\/.+$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type LedgerWriterRuntime = z.infer<typeof ledgerWriterRuntimeSchema>;
