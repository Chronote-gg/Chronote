import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "./configService";
import type { SuggestionHistoryEntry } from "../types/db";

export type NotesCorrectionTokenRecord = {
  guildId: string;
  meetingId: string;
  expiresAtMs: number;
  notesVersion: number;
  requesterId: string;
  newNotes: string;
  suggestion: SuggestionHistoryEntry;
};

export interface NotesCorrectionTokenStore {
  cleanup(): void;
  get(token: string): Promise<NotesCorrectionTokenRecord | null>;
  set(token: string, record: NotesCorrectionTokenRecord): Promise<void>;
  delete(token: string): Promise<void>;
}

const SESSION_TABLE_NAME = `${config.database.tablePrefix ?? ""}SessionTable`;
const NOTES_CORRECTION_TOKEN_PREFIX = "notesCorrection#";

const buildSid = (token: string) => `${NOTES_CORRECTION_TOKEN_PREFIX}${token}`;

class InMemoryNotesCorrectionTokenStore implements NotesCorrectionTokenStore {
  private pending = new Map<string, NotesCorrectionTokenRecord>();

  constructor(private readonly maxPending: number) {}

  cleanup(): void {
    const now = Date.now();
    for (const [token, record] of this.pending.entries()) {
      if (record.expiresAtMs <= now) {
        this.pending.delete(token);
      }
    }

    if (this.pending.size > this.maxPending) {
      const sorted = Array.from(this.pending.entries()).sort(
        (a, b) => a[1].expiresAtMs - b[1].expiresAtMs,
      );
      const overflow = this.pending.size - this.maxPending;
      for (let i = 0; i < overflow; i += 1) {
        this.pending.delete(sorted[i][0]);
      }
    }
  }

  async get(token: string): Promise<NotesCorrectionTokenRecord | null> {
    const record = this.pending.get(token);
    if (!record) return null;
    if (record.expiresAtMs <= Date.now()) {
      this.pending.delete(token);
      return null;
    }
    return record;
  }

  async set(token: string, record: NotesCorrectionTokenRecord): Promise<void> {
    this.pending.set(token, record);
    // Opportunistic cleanup when writing.
    this.cleanup();
  }

  async delete(token: string): Promise<void> {
    this.pending.delete(token);
  }
}

type DynamoNotesCorrectionItem = {
  sid: string;
  kind: "notesCorrectionToken";
  data: string;
  expiresAt: number; // seconds, Dynamo TTL
};

class DynamoNotesCorrectionTokenStore implements NotesCorrectionTokenStore {
  private client: DynamoDBClient;

  constructor() {
    this.client = new DynamoDBClient(
      config.database.useLocalDynamoDB
        ? {
            endpoint: "http://localhost:8000",
            region: "local",
            credentials: {
              accessKeyId: "dummy",
              secretAccessKey: "dummy",
            },
          }
        : { region: config.storage.awsRegion },
    );
  }

  cleanup(): void {
    // Dynamo TTL handles expiration. We still check expiresAtMs at read time to
    // avoid accepting tokens that are past their deadline but not yet deleted.
  }

  async get(token: string): Promise<NotesCorrectionTokenRecord | null> {
    const sid = buildSid(token);
    const res = await this.client.send(
      new GetItemCommand({
        TableName: SESSION_TABLE_NAME,
        Key: marshall({ sid }),
      }),
    );

    if (!res.Item) return null;
    const item = unmarshall(res.Item) as DynamoNotesCorrectionItem;
    if (item.kind !== "notesCorrectionToken") return null;

    const record = JSON.parse(item.data) as NotesCorrectionTokenRecord;
    if (record.expiresAtMs <= Date.now()) {
      await this.delete(token);
      return null;
    }

    return record;
  }

  async set(token: string, record: NotesCorrectionTokenRecord): Promise<void> {
    const sid = buildSid(token);
    const expiresAtSeconds = Math.floor(record.expiresAtMs / 1000);
    const item: DynamoNotesCorrectionItem = {
      sid,
      kind: "notesCorrectionToken",
      data: JSON.stringify(record),
      expiresAt: expiresAtSeconds,
    };
    await this.client.send(
      new PutItemCommand({
        TableName: SESSION_TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
      }),
    );
  }

  async delete(token: string): Promise<void> {
    const sid = buildSid(token);
    await this.client.send(
      new DeleteItemCommand({
        TableName: SESSION_TABLE_NAME,
        Key: marshall({ sid }),
      }),
    );
  }
}

export function createNotesCorrectionTokenStore(options: {
  ttlMs: number;
  maxPending: number;
}): NotesCorrectionTokenStore {
  if (config.mock.enabled) {
    return new InMemoryNotesCorrectionTokenStore(options.maxPending);
  }
  return new DynamoNotesCorrectionTokenStore();
}
