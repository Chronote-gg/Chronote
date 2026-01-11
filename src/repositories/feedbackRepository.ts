import {
  getFeedback as getFeedbackRecord,
  listFeedbackByTargetType,
  writeFeedback,
} from "../db";
import { config } from "../services/configService";
import type { FeedbackRecord, FeedbackTargetType } from "../types/db";
import { getMockStore } from "./mockStore";

export type FeedbackRepository = {
  write: (record: FeedbackRecord) => Promise<void>;
  get: (pk: string, sk: string) => Promise<FeedbackRecord | undefined>;
  listByTargetType: (params: {
    targetType: FeedbackTargetType;
    limit?: number;
    startAt?: string;
    endAt?: string;
  }) => Promise<FeedbackRecord[]>;
};

const realRepository: FeedbackRepository = {
  write: writeFeedback,
  get: getFeedbackRecord,
  listByTargetType: listFeedbackByTargetType,
};

const mockRepository: FeedbackRepository = {
  async write(record) {
    const store = getMockStore();
    const items = store.feedbackByTarget.get(record.pk) ?? [];
    const idx = items.findIndex((item) => item.sk === record.sk);
    if (idx >= 0) {
      items[idx] = record;
    } else {
      items.push(record);
    }
    store.feedbackByTarget.set(record.pk, items);
  },
  async get(pk, sk) {
    const items = getMockStore().feedbackByTarget.get(pk) ?? [];
    return items.find((item) => item.sk === sk);
  },
  async listByTargetType(params) {
    const items: FeedbackRecord[] = [];
    const prefix = `TARGET#${params.targetType}#`;
    for (const [pk, values] of getMockStore().feedbackByTarget.entries()) {
      if (!pk.startsWith(prefix)) continue;
      items.push(...values);
    }
    let filtered = items;
    const startAt = params.startAt;
    const endAt = params.endAt;
    if (startAt) {
      filtered = filtered.filter((item) => item.createdAt >= startAt);
    }
    if (endAt) {
      filtered = filtered.filter((item) => item.createdAt < endAt);
    }
    const sorted = filtered.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return sorted.slice(0, params.limit ?? 100);
  },
};

export function getFeedbackRepository(): FeedbackRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
