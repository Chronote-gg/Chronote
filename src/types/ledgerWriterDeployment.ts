import { z } from "zod";
import { ledgerWriterRuntimeSchema } from "./ledgerWriterRuntime";
const nonempty = z.string().min(1);
export const ledgerWriterDeploymentTargetSchema = z
  .object({
    clusterArn: nonempty,
    serviceArn: nonempty,
    containerName: nonempty,
    imageDigest: ledgerWriterRuntimeSchema.shape.imageDigest,
  })
  .strict();
export type LedgerWriterDeploymentTarget = z.infer<
  typeof ledgerWriterDeploymentTargetSchema
>;
export const ledgerWriterDeploymentSchema = ledgerWriterDeploymentTargetSchema
  .extend({ taskDefinitionArn: nonempty, taskArns: z.array(nonempty).min(1) })
  .strict();
export type LedgerWriterDeployment = z.infer<
  typeof ledgerWriterDeploymentSchema
>;
