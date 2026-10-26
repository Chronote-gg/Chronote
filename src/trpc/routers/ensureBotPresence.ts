import { TRPCError } from "@trpc/server";
import { ensureBotInGuild } from "../../services/guildAccessService";
import type { TrpcContext } from "../context";

export async function ensureBotPresence(ctx: TrpcContext, serverId: string) {
  const sessionData = ctx.req.session as typeof ctx.req.session & {
    botGuildIds?: string[];
    botGuildIdsFetchedAt?: number;
  };
  const cacheAgeMs =
    sessionData.botGuildIdsFetchedAt != null
      ? Date.now() - sessionData.botGuildIdsFetchedAt
      : Number.POSITIVE_INFINITY;
  const cacheFresh = cacheAgeMs < 5 * 60 * 1000;
  if (cacheFresh && sessionData.botGuildIds) {
    if (!sessionData.botGuildIds.includes(serverId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Bot is not in that guild",
      });
    }
    return;
  }
  await requireBotInGuild(serverId);
  sessionData.botGuildIds = Array.from(
    new Set([...(sessionData.botGuildIds ?? []), serverId]),
  );
  sessionData.botGuildIdsFetchedAt = Date.now();
}

export async function requireBotInGuild(serverId: string): Promise<void> {
  const botCheck = await ensureBotInGuild(serverId);
  if (botCheck === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!botCheck) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Bot is not in that guild",
    });
  }
}
