import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type {
  DictionaryTeachingContextRecord,
  DictionaryTeachingDraftRecord,
} from "../types/dictionaryTeaching";
import { config } from "./configService";

const SESSION_TABLE_NAME = `${config.database.tablePrefix ?? ""}SessionTable`;
const DRAFT_PREFIX = "dictionaryTeachingDraft#";
const CONTEXT_PREFIX = "dictionaryTeachingContext#";

const evidenceSchema = z.object({
  source: z.enum(["instruction", "notes_diff", "transcript_excerpt"]),
  quote: z.string(),
});

const draftSchema = z.object({
  draftId: z.string(),
  preferredTerm: z.string().nullable(),
  observedForms: z.array(z.string()),
  description: z.string().nullable(),
  ambiguity: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  action: z.enum(["create", "update", "conflict", "needs_input"]),
  existingEntry: z
    .object({
      guildId: z.string(),
      termKey: z.string(),
      term: z.string(),
      definition: z.string().optional(),
      observedForms: z.array(z.string()).optional(),
      createdAt: z.string(),
      createdBy: z.string(),
      updatedAt: z.string(),
      updatedBy: z.string(),
    })
    .passthrough()
    .optional(),
});

const draftRecordSchema = z.object({
  guildId: z.string(),
  requesterId: z.string(),
  expiresAtMs: z.number(),
  source: z.enum(["settings", "notes_correction"]),
  drafts: z.array(draftSchema),
  model: z.object({
    model: z.string(),
    promptName: z.string(),
    promptVersion: z.number().optional(),
  }),
  meetingId: z.string().optional(),
  correctionId: z.string().optional(),
});

const contextRecordSchema = z.object({
  guildId: z.string(),
  requesterId: z.string(),
  expiresAtMs: z.number(),
  context: z.object({
    source: z.enum(["settings", "notes_correction"]),
    meetingId: z.string().optional(),
    correctionId: z.string().optional(),
    notesDiff: z.string().optional(),
    transcriptExcerpt: z.string().optional(),
  }),
});

export interface DictionaryTeachingTokenStore {
  getDraft(token: string): Promise<DictionaryTeachingDraftRecord | null>;
  setDraft(token: string, record: DictionaryTeachingDraftRecord): Promise<void>;
  deleteDraft(token: string): Promise<void>;
  getContext(token: string): Promise<DictionaryTeachingContextRecord | null>;
  setContext(
    token: string,
    record: DictionaryTeachingContextRecord,
  ): Promise<void>;
  deleteContext(token: string): Promise<void>;
}

class InMemoryDictionaryTeachingTokenStore implements DictionaryTeachingTokenStore {
  private drafts = new Map<string, DictionaryTeachingDraftRecord>();
  private contexts = new Map<string, DictionaryTeachingContextRecord>();

  constructor(private readonly maxPending: number) {}

  private cleanup<T extends { expiresAtMs: number }>(map: Map<string, T>) {
    const now = Date.now();
    for (const [token, record] of map.entries()) {
      if (record.expiresAtMs <= now) map.delete(token);
    }
    if (map.size <= this.maxPending) return;
    const sorted = [...map.entries()].sort(
      (a, b) => a[1].expiresAtMs - b[1].expiresAtMs,
    );
    const overflow = map.size - this.maxPending;
    for (let index = 0; index < overflow; index += 1) {
      map.delete(sorted[index][0]);
    }
  }

  async getDraft(token: string) {
    this.cleanup(this.drafts);
    return this.drafts.get(token) ?? null;
  }

  async setDraft(token: string, record: DictionaryTeachingDraftRecord) {
    this.drafts.set(token, record);
    this.cleanup(this.drafts);
  }

  async deleteDraft(token: string) {
    this.drafts.delete(token);
  }

  async getContext(token: string) {
    this.cleanup(this.contexts);
    return this.contexts.get(token) ?? null;
  }

  async setContext(token: string, record: DictionaryTeachingContextRecord) {
    this.contexts.set(token, record);
    this.cleanup(this.contexts);
  }

  async deleteContext(token: string) {
    this.contexts.delete(token);
  }
}

let sharedInMemoryStore: DictionaryTeachingTokenStore | undefined;

type StoredKind = "dictionaryTeachingDraft" | "dictionaryTeachingContext";

type DynamoTokenItem = {
  sid: string;
  kind: StoredKind;
  data: string;
  expiresAt: number;
};

class DynamoDictionaryTeachingTokenStore implements DictionaryTeachingTokenStore {
  private client = new DynamoDBClient(
    config.database.useLocalDynamoDB
      ? {
          endpoint: "http://localhost:8000",
          region: "local",
          credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
        }
      : { region: config.storage.awsRegion },
  );

  private async get<T>(params: {
    token: string;
    prefix: string;
    kind: StoredKind;
    schema: z.ZodType<T>;
  }): Promise<T | null> {
    const sid = `${params.prefix}${params.token}`;
    const result = await this.client.send(
      new GetItemCommand({
        TableName: SESSION_TABLE_NAME,
        Key: marshall({ sid }),
      }),
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item) as DynamoTokenItem;
    if (item.kind !== params.kind) return null;

    try {
      const parsed = params.schema.parse(JSON.parse(item.data));
      const record = parsed as T & { expiresAtMs: number };
      if (record.expiresAtMs <= Date.now()) {
        await this.delete(params.prefix, params.token);
        return null;
      }
      return parsed;
    } catch (error) {
      console.warn("Invalid dictionary teaching token, deleting", {
        kind: params.kind,
        error,
      });
      await this.delete(params.prefix, params.token);
      return null;
    }
  }

  private async set<T>(params: {
    token: string;
    prefix: string;
    kind: StoredKind;
    record: T & { expiresAtMs: number };
  }) {
    const item: DynamoTokenItem = {
      sid: `${params.prefix}${params.token}`,
      kind: params.kind,
      data: JSON.stringify(params.record),
      expiresAt: Math.floor(params.record.expiresAtMs / 1_000),
    };
    await this.client.send(
      new PutItemCommand({
        TableName: SESSION_TABLE_NAME,
        Item: marshall(item),
      }),
    );
  }

  private async delete(prefix: string, token: string) {
    await this.client.send(
      new DeleteItemCommand({
        TableName: SESSION_TABLE_NAME,
        Key: marshall({ sid: `${prefix}${token}` }),
      }),
    );
  }

  getDraft(token: string) {
    return this.get({
      token,
      prefix: DRAFT_PREFIX,
      kind: "dictionaryTeachingDraft",
      schema: draftRecordSchema,
    });
  }

  setDraft(token: string, record: DictionaryTeachingDraftRecord) {
    return this.set({
      token,
      prefix: DRAFT_PREFIX,
      kind: "dictionaryTeachingDraft",
      record,
    });
  }

  deleteDraft(token: string) {
    return this.delete(DRAFT_PREFIX, token);
  }

  getContext(token: string) {
    return this.get({
      token,
      prefix: CONTEXT_PREFIX,
      kind: "dictionaryTeachingContext",
      schema: contextRecordSchema,
    });
  }

  setContext(token: string, record: DictionaryTeachingContextRecord) {
    return this.set({
      token,
      prefix: CONTEXT_PREFIX,
      kind: "dictionaryTeachingContext",
      record,
    });
  }

  deleteContext(token: string) {
    return this.delete(CONTEXT_PREFIX, token);
  }
}

export function createDictionaryTeachingTokenStore(options: {
  maxPending: number;
}): DictionaryTeachingTokenStore {
  if (!config.mock.enabled) return new DynamoDictionaryTeachingTokenStore();
  sharedInMemoryStore ??= new InMemoryDictionaryTeachingTokenStore(
    options.maxPending,
  );
  return sharedInMemoryStore;
}
