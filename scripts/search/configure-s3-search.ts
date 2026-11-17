import {
  GetIndexCommand,
  S3VectorsClient,
  UpdateIndexModeCommand,
  UpdateMetadataConfigurationCommand,
  type Index,
} from "@aws-sdk/client-s3vectors";
import { setTimeout as delay } from "node:timers/promises";

// AWS provider 6.71.0 cannot manage index mode or full-text configuration.
export const SEARCH_CONFIGURATION_VERSION = 1;

function validateIndex(index: Index, arn: string) {
  if (
    index.indexArn !== arn ||
    index.dataType !== "float32" ||
    index.dimension !== 1536 ||
    index.distanceMetric !== "cosine" ||
    JSON.stringify(
      index.metadataConfiguration?.nonFilterableMetadataKeys?.slice().sort(),
    ) !== JSON.stringify(["search_text"])
  ) {
    throw new Error(
      "Immutable search index configuration drift; provision a new generation",
    );
  }
  const fields = index.metadataConfiguration?.textSearchConfigurations ?? [];
  if (
    fields.some(
      (field) => field.metadataKey !== "search_text" || field.language,
    )
  ) {
    throw new Error("Unexpected text search configuration drift");
  }
}

export async function configureSearchIndex(
  client: S3VectorsClient,
  indexArn: string,
  apply = false,
  timeoutMs = 120_000,
) {
  if (
    !/^arn:aws:s3vectors:us-east-1:\d{12}:bucket\/[a-z0-9-]+\/index\/[a-z0-9-]+$/.test(
      indexArn,
    )
  ) {
    throw new Error("Expected an explicit us-east-1 search index ARN");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const read = async () => {
    const { index } = await client.send(new GetIndexCommand({ indexArn }), {
      abortSignal: signal,
    });
    if (!index) throw new Error("Search index not found");
    validateIndex(index, indexArn);
    return index;
  };
  let index = await read();
  let field = index.metadataConfiguration?.textSearchConfigurations?.[0];
  if (
    !apply &&
    (index.indexMode !== "ENHANCED" || field?.status !== "ACTIVE")
  ) {
    throw new Error(
      "Search configuration drift; review and run with --apply before enabling search",
    );
  }
  if (apply && index.indexMode !== "ENHANCED") {
    await client.send(
      new UpdateIndexModeCommand({ indexArn, indexMode: "ENHANCED" }),
      { abortSignal: signal },
    );
  }
  if (apply && !field) {
    await client.send(
      new UpdateMetadataConfigurationCommand({
        indexArn,
        add: { textSearchConfigurations: [{ metadataKey: "search_text" }] },
      }),
      { abortSignal: signal },
    );
  }
  while (index.indexMode !== "ENHANCED" || field?.status !== "ACTIVE") {
    await delay(1000, undefined, { signal });
    index = await read();
    field = index.metadataConfiguration?.textSearchConfigurations?.[0];
  }
  return {
    version: SEARCH_CONFIGURATION_VERSION,
    indexArn,
    mode: index.indexMode,
    textStatus: field.status,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args[0] === "--apply";
  const arns = apply ? args.slice(1) : args;
  if (arns.length !== 2 || new Set(arns).size !== 2) {
    throw new Error(
      "Usage: ts-node scripts/search/configure-s3-search.ts [--apply] <meeting-index-arn> <transcript-index-arn>",
    );
  }
  const client = new S3VectorsClient({ region: "us-east-1", maxAttempts: 3 });
  try {
    for (const arn of arns)
      console.log(
        JSON.stringify(await configureSearchIndex(client, arn, apply)),
      );
  } finally {
    client.destroy();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
