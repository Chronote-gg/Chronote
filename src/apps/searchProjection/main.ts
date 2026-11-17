import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
  GetVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../../services/configService";
import {
  createMeetingSearchStateRepository,
  decodeSearchProjectionCursor,
  encodeSearchProjectionCursor,
} from "../../repositories/meetingSearchStateRepository";
import {
  createMeetingSearchProjector,
  type SearchProjectionIndex,
} from "../../services/meetingSearchProjectionService";
import { embedSearchTexts } from "../../services/searchEmbeddingService";
import type { MeetingHistory } from "../../types/db";
import type { SearchProjectionKey } from "../../types/meetingSearchProjection";
import type { TranscriptPayload } from "../../types/transcript";

type ProjectionEvent = {
  Records?: {
    eventID?: string;
    dynamodb?: {
      Keys?: Record<string, AttributeValue>;
      SequenceNumber?: string;
    };
  }[];
};

type ProjectionContext = { getRemainingTimeInMillis(): number };
export function createSearchProjectionHandler(deps: {
  project(key: SearchProjectionKey, signal?: AbortSignal): Promise<void>;
  reconcile(signal?: AbortSignal): Promise<void>;
  flushTelemetry?(): Promise<void>;
}) {
  return async (event: ProjectionEvent, context?: ProjectionContext) => {
    const controller = new AbortController();
    // Reserve time to persist failed intents/checkpoints before Lambda's hard deadline.
    const deadline = setTimeout(
      () => controller.abort(),
      Math.max(1, (context?.getRemainingTimeInMillis() ?? 270_000) - 30_000),
    );
    try {
      if (!event.Records) {
        await deps.reconcile(controller.signal);
        return { batchItemFailures: [] };
      }
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const record of event.Records) {
        const identifier = record.dynamodb?.SequenceNumber ?? record.eventID;
        try {
          controller.signal.throwIfAborted();
          const key = record.dynamodb?.Keys
            ? unmarshall(record.dynamodb.Keys)
            : undefined;
          if (
            !key ||
            typeof key.guildId !== "string" ||
            typeof key.channelId_timestamp !== "string"
          )
            throw Error("Invalid projection stream key");
          await deps.project(
            {
              guildId: key.guildId,
              channelId_timestamp: key.channelId_timestamp,
            },
            controller.signal,
          );
        } catch {
          if (!identifier)
            throw Error("Projection record has no retry identity");
          batchItemFailures.push({ itemIdentifier: identifier });
        }
      }
      return { batchItemFailures };
    } finally {
      clearTimeout(deadline);
      if (deps.flushTelemetry) {
        let flushDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve()
              .then(deps.flushTelemetry)
              .catch(() => {}),
            new Promise<void>((resolve) => {
              flushDeadline = setTimeout(resolve, 2000);
            }),
          ]);
        } finally {
          clearTimeout(flushDeadline);
        }
      }
    }
  };
}

export function createSearchProjectionReconciler(deps: {
  generation: string;
  state: Pick<
    ReturnType<typeof createMeetingSearchStateRepository>,
    "checkpoint" | "saveCheckpoint" | "scan"
  >;
  sourcePage(
    cursor?: string,
  ): Promise<{ items: SearchProjectionKey[]; cursor?: string }>;
  project(key: SearchProjectionKey, signal?: AbortSignal): Promise<void>;
  now?: () => number;
}) {
  return async (signal?: AbortSignal) => {
    const checkpoint = await deps.state.checkpoint(deps.generation);
    const historyPage = await deps.sourcePage(checkpoint.historyCursor);
    let failures = 0;
    const seen = new Set<string>();
    const projectSafely = async (key: SearchProjectionKey) => {
      const ref = JSON.stringify([key.guildId, key.channelId_timestamp]);
      if (seen.has(ref)) return;
      seen.add(ref);
      try {
        await deps.project(key, signal);
      } catch {
        failures++;
      }
    };
    for (const key of historyPage.items) await projectSafely(key);
    checkpoint.historyCursor = historyPage.cursor;
    const statePage = await deps.state.scan(checkpoint.stateCursor);
    for (const item of statePage.items) {
      if (
        item.generation !== deps.generation ||
        item.retryAt > (deps.now ?? Date.now)()
      )
        continue;
      await projectSafely(item.meeting);
    }
    checkpoint.stateCursor = statePage.cursor;
    await deps.state.saveCheckpoint(deps.generation, checkpoint);
    // Advance the durable scan even during an outage; failed intents remain discoverable.
    if (failures)
      throw Error(
        `Search projection reconciliation failed for ${failures} sources`,
      );
  };
}

export async function initializeSearchProjectionTelemetry(
  readSecret: (arn: string) => Promise<string>,
) {
  const settings = config.search;
  const [publicKey, secretKey] = await Promise.all([
    settings.langfusePublicKeySecretArn
      ? readSecret(settings.langfusePublicKeySecretArn)
      : config.langfuse.publicKey,
    settings.langfuseSecretKeySecretArn
      ? readSecret(settings.langfuseSecretKeySecretArn)
      : config.langfuse.secretKey,
  ]);
  config.langfuse.publicKey = publicKey;
  config.langfuse.secretKey = secretKey;
  // The processor reads hydrated credentials before the first observed embedding request.
  const tracing = await import("../../observability/langfuseInstrumentation");
  tracing.startLangfuseTracing();
  return tracing.flushLangfuseTracing;
}

async function buildHandler() {
  const settings = config.search;
  if (
    !settings.generation ||
    !settings.stateTableName ||
    !settings.meetingIndexArn ||
    !settings.transcriptIndexArn
  )
    throw Error("Search projection configuration incomplete");
  if (settings.openaiSecretArn) {
    const secret = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: settings.openaiSecretArn }),
    );
    if (!secret.SecretString?.trim())
      throw Error("Search embedding secret is empty");
    config.openai.apiKey = secret.SecretString;
  }
  if (!config.openai.apiKey)
    throw Error("Search embedding credential unavailable");
  const flushTelemetry = await initializeSearchProjectionTelemetry(
    async (arn) => {
      const secret = await new SecretsManagerClient({}).send(
        new GetSecretValueCommand({ SecretId: arn }),
      );
      if (!secret.SecretString?.trim())
        throw Error("Search telemetry secret unavailable");
      return secret.SecretString;
    },
  );
  const clientOptions = {
    maxAttempts: 2,
    requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 },
  };
  const db = new DynamoDBClient(clientOptions);
  const s3 = new S3Client(clientOptions);
  const vectors = new S3VectorsClient(clientOptions);
  const state = createMeetingSearchStateRepository(db, settings.stateTableName);
  const arn = (dataset: "meetings" | "transcripts") =>
    dataset === "meetings"
      ? settings.meetingIndexArn
      : settings.transcriptIndexArn;
  const index: SearchProjectionIndex = {
    async put(documents, signal) {
      for (const dataset of ["meetings", "transcripts"] as const) {
        const records = documents.filter((d) => d.dataset === dataset);
        if (!records.length) continue;
        await vectors.send(
          new PutVectorsCommand({
            indexArn: arn(dataset),
            vectors: records.map((d) => ({
              key: d.key,
              data: { float32: d.vector },
              metadata: { ...d.metadata, search_text: d.text },
            })),
          }),
          { abortSignal: signal },
        );
      }
    },
    async remove(dataset, keys) {
      await vectors.send(
        new DeleteVectorsCommand({ indexArn: arn(dataset), keys }),
      );
    },
    async get(dataset, key) {
      const result = await vectors.send(
        new GetVectorsCommand({
          indexArn: arn(dataset),
          keys: [key],
          returnData: true,
        }),
      );
      return result.vectors?.[0]?.data?.float32;
    },
  };
  const project = createMeetingSearchProjector({
    generation: settings.generation,
    state,
    index,
    embed: embedSearchTexts,
    source: {
      async get(key, signal) {
        const result = await db.send(
          new GetItemCommand({
            TableName: settings.historyTableName,
            Key: marshall(key),
            ConsistentRead: true,
          }),
          { abortSignal: signal },
        );
        return result.Item
          ? (unmarshall(result.Item) as MeetingHistory)
          : undefined;
      },
      async transcript(history, signal) {
        if (!history.transcriptS3Key) return history.transcript ?? "";
        // Storage's optional-read helper swallows provider errors; projection must retain retry state.
        const object = await s3.send(
          new GetObjectCommand({
            Bucket: config.storage.transcriptBucket,
            Key: history.transcriptS3Key,
          }),
          { abortSignal: signal },
        );
        const body = await object.Body?.transformToString();
        if (!body) throw Error("Canonical transcript unavailable");
        const payload = JSON.parse(body) as TranscriptPayload;
        if (typeof payload.text !== "string")
          throw Error("Canonical transcript text unavailable");
        return payload.text;
      },
    },
  });
  return createSearchProjectionHandler({
    project,
    flushTelemetry,
    reconcile: createSearchProjectionReconciler({
      generation: settings.generation,
      state,
      project,
      async sourcePage(cursor) {
        const page = await db.send(
          new ScanCommand({
            TableName: settings.historyTableName,
            Limit: 5,
            ConsistentRead: true,
            ProjectionExpression: "guildId, channelId_timestamp",
            ExclusiveStartKey: decodeSearchProjectionCursor(cursor),
          }),
        );
        return {
          items: (page.Items ?? []).map(
            (item) => unmarshall(item) as SearchProjectionKey,
          ),
          cursor: encodeSearchProjectionCursor(page.LastEvaluatedKey),
        };
      },
    }),
  });
}

let instance: ReturnType<typeof buildHandler> | undefined;
export async function handler(
  event: ProjectionEvent,
  context?: ProjectionContext,
) {
  instance ??= buildHandler().catch((error) => {
    instance = undefined;
    throw error;
  });
  return (await instance)(event, context);
}
