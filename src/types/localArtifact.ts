import { z } from "zod";
import { checkpointObjectSchema } from "./recordingCheckpoint";

export const MAX_LOCAL_ARTIFACT_ENTRIES = 10_000;
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.startsWith("/") &&
      !/^[a-z]:/i.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Artifact paths must stay inside their managed directory",
  );
export const localArtifactSchema = checkpointObjectSchema
  .omit({ key: true })
  .extend({ path: localPath })
  .strict();
export const localArtifactsSchema = z
  .array(localArtifactSchema)
  .max(MAX_LOCAL_ARTIFACT_ENTRIES)
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === files.length,
    "Artifact paths must be unique",
  );
export type LocalArtifact = z.infer<typeof localArtifactSchema>;
export type LocalArtifactInventory = {
  files: LocalArtifact[];
  byteLength: number;
  digest: string;
};
