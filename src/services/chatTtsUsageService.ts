import { getChatTtsUsageRepository } from "../repositories/chatTtsUsageRepository";
import type { ChatTtsMonthlyUsage } from "../types/db";
import { buildUpgradeTextOnly } from "../utils/upgradePrompt";

const USAGE_TTL_DAYS = 400;
const USAGE_TTL_MS = USAGE_TTL_DAYS * 24 * 60 * 60 * 1000;

export type ChatTtsUsageLimitStatus = {
  allowed: boolean;
  guildId: string;
  period: string;
  limit?: number;
  used: number;
  remaining?: number;
};

export type ChatTtsUsageReservation = ChatTtsUsageLimitStatus & {
  reserved: boolean;
};

export function getChatTtsUsagePeriod(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function getUsageExpiryEpochSeconds(now: Date): number {
  return Math.floor((now.getTime() + USAGE_TTL_MS) / 1000);
}

function getRemaining(used: number, limit?: number) {
  return limit === undefined ? undefined : Math.max(limit - used, 0);
}

function formatOrdinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value.toLocaleString("en-US")}th`;
  const suffix = ["th", "st", "nd", "rd"][Math.min(value % 10, 3)] ?? "th";
  return `${value.toLocaleString("en-US")}${suffix}`;
}

function buildStatus(options: {
  guildId: string;
  period: string;
  limit?: number;
  used: number;
}): ChatTtsUsageLimitStatus {
  const { guildId, period, limit, used } = options;
  return {
    allowed: limit === undefined || used < limit,
    guildId,
    period,
    limit,
    used,
    remaining: getRemaining(used, limit),
  };
}

export async function checkChatTtsMessageUsageLimit(options: {
  guildId: string;
  limit?: number;
  now?: Date;
}): Promise<ChatTtsUsageLimitStatus> {
  const { guildId, limit, now = new Date() } = options;
  const period = getChatTtsUsagePeriod(now);
  if (limit === undefined) {
    return buildStatus({ guildId, period, limit, used: 0 });
  }
  if (limit <= 0) {
    return {
      ...buildStatus({ guildId, period, limit, used: 0 }),
      allowed: false,
    };
  }

  const usage = await getChatTtsUsageRepository().get(guildId, period);
  return buildStatus({
    guildId,
    period,
    limit,
    used: usage?.acceptedMessages ?? 0,
  });
}

export async function reserveChatTtsMessageUsage(options: {
  guildId: string;
  limit?: number;
  now?: Date;
}): Promise<ChatTtsUsageReservation> {
  const { guildId, limit, now = new Date() } = options;
  const period = getChatTtsUsagePeriod(now);
  if (limit === undefined) {
    return {
      ...buildStatus({ guildId, period, limit, used: 0 }),
      reserved: false,
    };
  }
  if (limit <= 0) {
    return {
      ...buildStatus({ guildId, period, limit, used: 0 }),
      allowed: false,
      reserved: false,
    };
  }

  const timestamp = now.toISOString();
  const usage: ChatTtsMonthlyUsage = {
    guildId,
    period,
    acceptedMessages: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: getUsageExpiryEpochSeconds(now),
  };
  const reserved = await getChatTtsUsageRepository().tryReserve(usage, limit);
  if (reserved) {
    return {
      ...buildStatus({
        guildId,
        period,
        limit,
        used: reserved.acceptedMessages,
      }),
      allowed: true,
      reserved: true,
    };
  }

  const current = await getChatTtsUsageRepository().get(guildId, period);
  return {
    ...buildStatus({
      guildId,
      period,
      limit,
      used: current?.acceptedMessages ?? limit,
    }),
    allowed: false,
    reserved: false,
  };
}

export async function releaseChatTtsMessageUsageReservation(options: {
  guildId: string;
  period: string;
  now?: Date;
}): Promise<void> {
  const { guildId, period, now = new Date() } = options;
  await getChatTtsUsageRepository().releaseReservation(
    guildId,
    period,
    now.toISOString(),
  );
}

export function buildChatTtsMonthlyLimitMessage(
  status: ChatTtsUsageLimitStatus,
  options: { finalAcceptedMessage?: boolean } = {},
): string {
  const count = Math.max(status.used, status.limit ?? 0);
  const formattedCount = count.toLocaleString("en-US");
  if (options.finalAcceptedMessage) {
    return `That was this server's ${formatOrdinal(count)} chat-to-speech message this month. Upgrade to keep using TTS and support our team.`;
  }
  return `This server has spoken ${formattedCount} chat-to-speech messages out loud with Chronote this month. Upgrade to keep using TTS and support our team.`;
}

export function buildChatTtsMonthlyLimitTextOnly(
  status: ChatTtsUsageLimitStatus,
  options: { finalAcceptedMessage?: boolean } = {},
): string {
  return buildUpgradeTextOnly(buildChatTtsMonthlyLimitMessage(status, options));
}
