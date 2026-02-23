import { listContactFeedback, writeContactFeedback } from "../db";
import { config } from "../services/configService";
import type { ContactFeedbackRecord } from "../types/db";
import { getMockStore } from "./mockStore";

export type ContactFeedbackRepository = {
  write: (record: ContactFeedbackRecord) => Promise<void>;
  list: (params: {
    limit?: number;
    startAt?: string;
    endAt?: string;
  }) => Promise<ContactFeedbackRecord[]>;
};

const realRepository: ContactFeedbackRepository = {
  write: writeContactFeedback,
  list: listContactFeedback,
};

const mockRepository: ContactFeedbackRepository = {
  async write(record) {
    getMockStore().contactFeedback.push(record);
  },
  async list(params) {
    let items = [...getMockStore().contactFeedback];
    if (params.startAt) {
      items = items.filter((item) => item.createdAt >= params.startAt!);
    }
    if (params.endAt) {
      items = items.filter((item) => item.createdAt < params.endAt!);
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items.slice(0, params.limit ?? 50);
  },
};

export function getContactFeedbackRepository(): ContactFeedbackRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
