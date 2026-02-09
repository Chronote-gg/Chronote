import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CONFIG_KEYS } from "../../config/keys";
import {
  askWithConversation,
  getAskConversationWithMessages,
  getSharedConversationWithMessages,
  listSharedAskConversations,
  listAskConversations,
  renameAskConversation,
  setAskConversationArchived,
  setAskConversationVisibility,
} from "../../services/askConversationService";
import {
  getSnapshotBoolean,
  getSnapshotEnum,
  resolveConfigSnapshot,
} from "../../services/unifiedConfigService";
import {
  ensureManageGuildWithUserToken,
  type GuildSessionCache,
} from "../../services/guildAccessService";
import { guildMemberProcedure, publicProcedure, router } from "../trpc";
import { PERMISSION_REASONS } from "../permissions";

const resolveAskSettings = async (guildId: string) => {
  const snapshot = await resolveConfigSnapshot({ guildId });
  const askMembersEnabled = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.ask.membersEnabled,
  );
  const askSharingPolicy =
    getSnapshotEnum(snapshot, CONFIG_KEYS.ask.sharingPolicy, [
      "off",
      "server",
      "public",
    ]) ?? "server";
  return { askMembersEnabled, askSharingPolicy };
};

const resolveAskAccess = async (options: {
  accessToken: string;
  guildId: string;
  userId?: string;
  session?: GuildSessionCache;
}) => {
  const settings = await resolveAskSettings(options.guildId);
  let isManager = false;
  const manageCheck = await ensureManageGuildWithUserToken(
    options.accessToken,
    options.guildId,
    { userId: options.userId, session: options.session },
  );
  if (manageCheck === null && !settings.askMembersEnabled) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
      cause: { reason: PERMISSION_REASONS.discordRateLimited },
    });
  }
  if (manageCheck === true) {
    isManager = true;
  } else if (!settings.askMembersEnabled) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Ask is disabled for members",
      cause: { reason: PERMISSION_REASONS.askMembersDisabled },
    });
  }
  return { settings, isManager };
};

const ensureSharingAllowed = (
  policy: string,
  visibility?: "private" | "server" | "public",
) => {
  if (visibility === "private") return;
  if (policy === "off") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Sharing is disabled for this server",
      cause: { reason: PERMISSION_REASONS.askSharingDisabled },
    });
  }
  if (visibility === "public" && policy !== "public") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Public sharing is disabled for this server",
      cause: { reason: PERMISSION_REASONS.askSharingDisabled },
    });
  }
};

const settings = guildMemberProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ input }) => resolveAskSettings(input.serverId));

const ask = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      question: z.string().min(1),
      conversationId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      scope: z.enum(["guild", "channel"]).optional(),
      channelId: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const result = await askWithConversation({
      userId: ctx.user.id,
      guildId: input.serverId,
      question: input.question,
      conversationId: input.conversationId,
      channelId: input.channelId,
      tags: input.tags,
      scope: input.scope,
      viewerUserId: ctx.user.id,
    });
    return result;
  });

const listConversations = guildMemberProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ ctx, input }) => {
    await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const conversations = await listAskConversations(
      ctx.user.id,
      input.serverId,
    );
    return { conversations };
  });

const listSharedConversations = guildMemberProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ ctx, input }) => {
    const { settings } = await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    ensureSharingAllowed(settings.askSharingPolicy);
    const conversations = await listSharedAskConversations(
      input.serverId,
      ctx.user.id,
    );
    return { conversations };
  });

const getConversation = guildMemberProcedure
  .input(z.object({ serverId: z.string(), conversationId: z.string() }))
  .query(async ({ ctx, input }) => {
    await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const result = await getAskConversationWithMessages(
      ctx.user.id,
      input.serverId,
      input.conversationId,
    );
    if (!result) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return result;
  });

const getSharedConversation = guildMemberProcedure
  .input(z.object({ serverId: z.string(), conversationId: z.string() }))
  .query(async ({ ctx, input }) => {
    const { settings } = await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    ensureSharingAllowed(settings.askSharingPolicy);
    const result = await getSharedConversationWithMessages(
      input.serverId,
      input.conversationId,
    );
    if (!result) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return result;
  });

const getPublicConversation = publicProcedure
  .input(z.object({ serverId: z.string(), conversationId: z.string() }))
  .query(async ({ input }) => {
    const settings = await resolveAskSettings(input.serverId);
    if (settings.askSharingPolicy !== "public") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    const result = await getSharedConversationWithMessages(
      input.serverId,
      input.conversationId,
    );
    if (!result || result.conversation.visibility !== "public") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return result;
  });

const rename = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      conversationId: z.string(),
      title: z.string().min(1).max(120),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const updated = await renameAskConversation(
      ctx.user.id,
      input.serverId,
      input.conversationId,
      input.title,
    );
    if (!updated) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return { conversation: updated };
  });

const setVisibility = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      conversationId: z.string(),
      visibility: z.enum(["private", "server", "public"]),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const { settings } = await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    ensureSharingAllowed(settings.askSharingPolicy, input.visibility);
    const updated = await setAskConversationVisibility({
      userId: ctx.user.id,
      guildId: input.serverId,
      conversationId: input.conversationId,
      visibility: input.visibility,
      sharedByTag:
        ctx.user.discriminator && ctx.user.discriminator !== "0"
          ? `${ctx.user.username}#${ctx.user.discriminator}`
          : ctx.user.username,
    });
    if (!updated) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return { conversation: updated };
  });

const setArchived = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      conversationId: z.string(),
      archived: z.boolean(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await resolveAskAccess({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const updated = await setAskConversationArchived({
      userId: ctx.user.id,
      guildId: input.serverId,
      conversationId: input.conversationId,
      archived: input.archived,
    });
    if (!updated) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return { conversation: updated };
  });

export const askRouter = router({
  settings,
  ask,
  listConversations,
  listSharedConversations,
  getConversation,
  getSharedConversation,
  getPublicConversation,
  rename,
  setVisibility,
  setArchived,
});
