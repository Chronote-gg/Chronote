import { z } from "zod";
import { checkpointObjectSchema } from "./recordingCheckpoint";

export const storedArtifactSchema = checkpointObjectSchema
  .extend({
    versionId: z.string().min(1).nullable(),
  })
  .strict();

export type StoredArtifact = z.infer<typeof storedArtifactSchema>;
