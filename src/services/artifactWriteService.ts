import type { ArtifactWriter } from "./artifactProducerRegistry";

export async function withArtifactWrite<T>(
  begin: ArtifactWriter | undefined,
  filename: string,
  write: () => Promise<T>,
): Promise<T> {
  const owned = begin?.(filename);
  try {
    const result = await write();
    owned?.settle("known");
    return result;
  } catch (error) {
    owned?.settle("uncertain");
    throw error;
  }
}
