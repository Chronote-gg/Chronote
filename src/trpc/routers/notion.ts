import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CONFIG_KEYS } from "../../config/keys";
import { config } from "../../services/configService";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
  type GuildSessionCache,
} from "../../services/guildAccessService";
import { ensureUserCanAccessMeeting } from "../../services/meetingAccessService";
import { authedProcedure, router } from "../trpc";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import { retryNotionAutomationExport } from "../../services/notionAutomationService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "../../services/unifiedConfigService";
import {
  exportMeetingToNotion,
  getEffectiveMeetingNotionExportStatus,
  getNotionAutomationStatus,
  getNotionStatus,
  listNotionDestinationPages,
  NotionApiError,
  saveNotionAutomationConfig,
  setNotionAutomationEnabled,
  syncMeetingToNotion,
} from "../../services/notionService";
import {
  buildPersonalMeetingGuildId,
  isPersonalMeeting,
  PERSONAL_MEETING_GUILD_ID_PREFIX,
  resolveMeetingOwnerUserId,
} from "../../utils/meetingOwnership";

const meetingInput = z.object({
  serverId: z.string(),
  meetingId: z.string(),
});

const serverInput = z.object({
  serverId: z.string(),
});

const destinationSearchInput = serverInput.extend({
  query: z.string().max(100).optional(),
});

const automationConfigInput = serverInput.extend({
  destinationPageId: z.string().min(1),
  autoExportEnabled: z.boolean(),
  channelIds: z.array(z.string().min(1)).max(100).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

const ensureNotionConfigured = () => {
  if (!config.notion.enabled) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notion export is not configured.",
    });
  }
};

const isPersonalScopeId = (serverId: string) =>
  serverId.startsWith(PERSONAL_MEETING_GUILD_ID_PREFIX);

const ensureOwnPersonalScope = (params: {
  serverId: string;
  userId: string;
}) => {
  if (params.serverId === buildPersonalMeetingGuildId(params.userId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Personal Notion automation can only be managed by its owner.",
  });
};

const ensureGuildMemberScope = async (params: {
  accessToken?: string;
  serverId: string;
  session?: GuildSessionCache;
  userId: string;
}) => {
  if (isPersonalScopeId(params.serverId)) return;
  const allowed = await ensureUserInGuild(params.accessToken, params.serverId, {
    session: params.session,
    userId: params.userId,
  });
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Guild membership required",
    });
  }
};

const ensureManageAutomationScope = async (params: {
  accessToken?: string;
  serverId: string;
  session?: GuildSessionCache;
  userId: string;
}) => {
  if (isPersonalScopeId(params.serverId)) {
    ensureOwnPersonalScope(params);
    return;
  }
  const allowed = await ensureManageGuildWithUserToken(
    params.accessToken,
    params.serverId,
    { session: params.session, userId: params.userId },
  );
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Manage Guild required",
    });
  }
};

const ensureAutomationStatusScope = async (params: {
  accessToken?: string;
  serverId: string;
  session?: GuildSessionCache;
  userId: string;
}) => {
  if (isPersonalScopeId(params.serverId)) {
    ensureOwnPersonalScope(params);
    return;
  }
  await ensureGuildMemberScope(params);
};

const resolveAttendeeAccessEnabled = async (guildId: string) => {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.meetings.attendeeAccessEnabled,
    );
  } catch (error) {
    console.warn("Failed to resolve attendee access setting", {
      guildId,
      error,
    });
    return true;
  }
};

const toTrpcNotionError = (err: unknown): TRPCError => {
  if (err instanceof TRPCError) return err;
  if (!(err instanceof NotionApiError)) {
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }
  if (err.code === "not_connected" || err.code === "missing_refresh_token") {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err.code === "not_exported") {
    return new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err.status === 401) {
    return new TRPCError({
      code: "UNAUTHORIZED",
      message: "Reconnect Notion and try again.",
    });
  }
  if (err.status === 403 || err.status === 404) {
    return new TRPCError({
      code: "FORBIDDEN",
      message: "Chronote cannot access that Notion page. Reconnect Notion.",
    });
  }
  if (err.status === 429) {
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Notion is rate limiting requests. Try again shortly.",
    });
  }
  if (err.status === 409) {
    return new TRPCError({ code: "CONFLICT", message: err.message });
  }
  if (err.status === 400) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
};

const requireMeeting = async (serverId: string, meetingId: string) => {
  const meeting = await getMeetingHistoryService(serverId, meetingId);
  if (!meeting) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
  }
  return meeting;
};

const requireAccessibleMeeting = async (params: {
  accessToken?: string;
  serverId: string;
  session?: GuildSessionCache;
  meetingId: string;
  userId: string;
}) => {
  const meeting = await requireMeeting(params.serverId, params.meetingId);
  const attendeeOverrideEnabled = isPersonalMeeting(meeting)
    ? true
    : await resolveAttendeeAccessEnabled(params.serverId);
  const sharedGuildIds = await resolvePersonalSharedGuildIds({
    accessToken: params.accessToken,
    meeting,
    session: params.session,
    userId: params.userId,
  });
  const accessParams = {
    guildId: params.serverId,
    meeting,
    userId: params.userId,
    attendeeOverrideEnabled,
    ...(sharedGuildIds ? { sharedGuildIds } : {}),
  };
  const allowed = await ensureUserCanAccessMeeting(accessParams);
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Meeting access required.",
    });
  }
  return meeting;
};

const resolvePersonalSharedGuildIds = async (params: {
  accessToken?: string;
  meeting: Awaited<ReturnType<typeof requireMeeting>>;
  session?: GuildSessionCache;
  userId: string;
}) => {
  if (!isPersonalMeeting(params.meeting)) return undefined;
  const sharedGuildIds = (params.meeting.accessGrants ?? [])
    .filter((grant) => grant.targetType === "guild")
    .map((grant) => grant.guildId);
  if (sharedGuildIds.length === 0) return undefined;

  const allowedGuildIds: string[] = [];
  for (const guildId of sharedGuildIds) {
    const allowed = await ensureUserInGuild(params.accessToken, guildId, {
      session: params.session,
      userId: params.userId,
    });
    if (allowed === null) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Discord rate limited. Please retry.",
      });
    }
    if (allowed) allowedGuildIds.push(guildId);
  }
  return allowedGuildIds;
};

const ensurePersonalAutomationOwner = (params: {
  meeting: Awaited<ReturnType<typeof requireMeeting>>;
  userId: string;
}) => {
  if (!isPersonalMeeting(params.meeting)) return;
  if (resolveMeetingOwnerUserId(params.meeting) === params.userId) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the personal meeting owner can retry automation.",
  });
};

export const notionRouter = router({
  status: authedProcedure.query(({ ctx }) => getNotionStatus(ctx.user.id)),

  automationStatus: authedProcedure
    .input(serverInput)
    .query(async ({ ctx, input }) => {
      await ensureAutomationStatusScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      return getNotionAutomationStatus({
        guildId: input.serverId,
        userId: ctx.user.id,
      });
    }),

  destinationPages: authedProcedure
    .input(destinationSearchInput)
    .query(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureManageAutomationScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      try {
        return {
          pages: await listNotionDestinationPages({
            userId: ctx.user.id,
            query: input.query,
          }),
        };
      } catch (err) {
        throw toTrpcNotionError(err);
      }
    }),

  saveAutomationConfig: authedProcedure
    .input(automationConfigInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureManageAutomationScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      try {
        const automationConfig = await saveNotionAutomationConfig({
          guildId: input.serverId,
          userId: ctx.user.id,
          destinationPageId: input.destinationPageId,
          autoExportEnabled: input.autoExportEnabled,
          channelIds: input.channelIds,
          tags: input.tags,
        });
        return { ok: true, automationConfig };
      } catch (err) {
        throw toTrpcNotionError(err);
      }
    }),

  disableAutomation: authedProcedure
    .input(serverInput)
    .mutation(async ({ ctx, input }) => {
      await ensureManageAutomationScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      await setNotionAutomationEnabled({
        guildId: input.serverId,
        enabled: false,
      });
      return { ok: true };
    }),

  retryAutomationExport: authedProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureManageAutomationScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      const meeting = await requireMeeting(input.serverId, input.meetingId);
      ensurePersonalAutomationOwner({ meeting, userId: ctx.user.id });
      try {
        const exported = await retryNotionAutomationExport(meeting);
        return {
          ok: true,
          pageUrl: exported?.notionPageUrl,
          exportedNotesVersion: exported?.exportedNotesVersion,
        };
      } catch (err) {
        throw toTrpcNotionError(err);
      }
    }),

  exportStatus: authedProcedure
    .input(meetingInput)
    .query(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureGuildMemberScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      const meeting = await requireAccessibleMeeting({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        meetingId: input.meetingId,
        userId: ctx.user.id,
      });
      return getEffectiveMeetingNotionExportStatus({
        userId: ctx.user.id,
        guildId: input.serverId,
        meetingId: input.meetingId,
        currentNotesVersion: meeting.notesVersion ?? 1,
      });
    }),

  exportMeeting: authedProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureGuildMemberScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      const meeting = await requireAccessibleMeeting({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        meetingId: input.meetingId,
        userId: ctx.user.id,
      });
      try {
        const exported = await exportMeetingToNotion({
          userId: ctx.user.id,
          meeting,
        });
        return {
          ok: true,
          pageUrl: exported.notionPageUrl,
          exportedNotesVersion: exported.exportedNotesVersion,
        };
      } catch (err) {
        throw toTrpcNotionError(err);
      }
    }),

  syncMeeting: authedProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      await ensureGuildMemberScope({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        userId: ctx.user.id,
      });
      const meeting = await requireAccessibleMeeting({
        accessToken: ctx.user.accessToken,
        serverId: input.serverId,
        session: ctx.req.session,
        meetingId: input.meetingId,
        userId: ctx.user.id,
      });
      try {
        const exported = await syncMeetingToNotion({
          userId: ctx.user.id,
          meeting,
        });
        return {
          ok: true,
          pageUrl: exported.notionPageUrl,
          exportedNotesVersion: exported.exportedNotesVersion,
        };
      } catch (err) {
        throw toTrpcNotionError(err);
      }
    }),
});
