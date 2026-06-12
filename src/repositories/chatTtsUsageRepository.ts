import { config } from "../services/configService";
import {
  getChatTtsMonthlyUsage,
  releaseChatTtsMonthlyUsageReservation,
  tryReserveChatTtsMonthlyUsage,
} from "../db";
import type { ChatTtsMonthlyUsage } from "../types/db";
import { getMockStore } from "./mockStore";

export type ChatTtsUsageRepository = {
  get: (
    guildId: string,
    period: string,
  ) => Promise<ChatTtsMonthlyUsage | undefined>;
  tryReserve: (
    usage: ChatTtsMonthlyUsage,
    maxMessages: number,
  ) => Promise<ChatTtsMonthlyUsage | undefined>;
  releaseReservation: (
    guildId: string,
    period: string,
    updatedAt: string,
  ) => Promise<void>;
};

const keyFor = (guildId: string, period: string) => `${guildId}#${period}`;

const realRepository: ChatTtsUsageRepository = {
  get: getChatTtsMonthlyUsage,
  tryReserve: tryReserveChatTtsMonthlyUsage,
  releaseReservation: releaseChatTtsMonthlyUsageReservation,
};

const mockRepository: ChatTtsUsageRepository = {
  async get(guildId, period) {
    return getMockStore().chatTtsMonthlyUsage.get(keyFor(guildId, period));
  },
  async tryReserve(usage, maxMessages) {
    const key = keyFor(usage.guildId, usage.period);
    const existing = getMockStore().chatTtsMonthlyUsage.get(key);
    const acceptedMessages = existing?.acceptedMessages ?? 0;
    if (acceptedMessages >= maxMessages) return undefined;
    const next: ChatTtsMonthlyUsage = {
      ...usage,
      createdAt: existing?.createdAt ?? usage.createdAt,
      acceptedMessages: acceptedMessages + 1,
    };
    getMockStore().chatTtsMonthlyUsage.set(key, next);
    return next;
  },
  async releaseReservation(guildId, period, updatedAt) {
    const key = keyFor(guildId, period);
    const existing = getMockStore().chatTtsMonthlyUsage.get(key);
    if (!existing || existing.acceptedMessages <= 0) return;
    getMockStore().chatTtsMonthlyUsage.set(key, {
      ...existing,
      acceptedMessages: existing.acceptedMessages - 1,
      updatedAt,
    });
  },
};

export function getChatTtsUsageRepository(): ChatTtsUsageRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
