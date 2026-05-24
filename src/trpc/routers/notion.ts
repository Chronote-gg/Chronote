import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CONFIG_KEYS } from "../../config/keys";
import { config } from "../../services/configService";
import { ensureUserCanAccessMeeting } from "../../services/meetingAccessService";
import {
  authedProcedure,
  guildMemberProcedure,
  manageGuildProcedure,
  router,
} from "../trpc";
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
  serverId: string;
  meetingId: string;
  userId: string;
}) => {
  const meeting = await requireMeeting(params.serverId, params.meetingId);
  const attendeeOverrideEnabled = await resolveAttendeeAccessEnabled(
    params.serverId,
  );
  const allowed = await ensureUserCanAccessMeeting({
    guildId: params.serverId,
    meeting,
    userId: params.userId,
    attendeeOverrideEnabled,
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
      message: "Meeting access required.",
    });
  }
  return meeting;
};

export const notionRouter = router({
  status: authedProcedure.query(({ ctx }) => getNotionStatus(ctx.user.id)),

  automationStatus: guildMemberProcedure
    .input(serverInput)
    .query(({ ctx, input }) =>
      getNotionAutomationStatus({
        guildId: input.serverId,
        userId: ctx.user.id,
      }),
    ),

  destinationPages: manageGuildProcedure
    .input(destinationSearchInput)
    .query(async ({ ctx, input }) => {
      ensureNotionConfigured();
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

  saveAutomationConfig: manageGuildProcedure
    .input(automationConfigInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
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

  disableAutomation: manageGuildProcedure
    .input(serverInput)
    .mutation(async ({ input }) => {
      await setNotionAutomationEnabled({
        guildId: input.serverId,
        enabled: false,
      });
      return { ok: true };
    }),

  retryAutomationExport: manageGuildProcedure
    .input(meetingInput)
    .mutation(async ({ input }) => {
      ensureNotionConfigured();
      const meeting = await requireMeeting(input.serverId, input.meetingId);
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

  exportStatus: guildMemberProcedure
    .input(meetingInput)
    .query(async ({ ctx, input }) => {
      ensureNotionConfigured();
      const meeting = await requireAccessibleMeeting({
        serverId: input.serverId,
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

  exportMeeting: guildMemberProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      const meeting = await requireAccessibleMeeting({
        serverId: input.serverId,
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

  syncMeeting: guildMemberProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      ensureNotionConfigured();
      const meeting = await requireAccessibleMeeting({
        serverId: input.serverId,
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
