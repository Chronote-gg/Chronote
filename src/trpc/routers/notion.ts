import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authedProcedure, guildMemberProcedure, router } from "../trpc";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import {
  exportMeetingToNotion,
  getMeetingNotionExportStatus,
  getNotionStatus,
  NotionApiError,
  syncMeetingToNotion,
} from "../../services/notionService";

const meetingInput = z.object({
  serverId: z.string(),
  meetingId: z.string(),
});

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

export const notionRouter = router({
  status: authedProcedure.query(({ ctx }) => getNotionStatus(ctx.user.id)),

  exportStatus: guildMemberProcedure
    .input(meetingInput)
    .query(async ({ ctx, input }) => {
      const meeting = await requireMeeting(input.serverId, input.meetingId);
      return getMeetingNotionExportStatus({
        userId: ctx.user.id,
        guildId: input.serverId,
        meetingId: input.meetingId,
        currentNotesVersion: meeting.notesVersion ?? 1,
      });
    }),

  exportMeeting: guildMemberProcedure
    .input(meetingInput)
    .mutation(async ({ ctx, input }) => {
      const meeting = await requireMeeting(input.serverId, input.meetingId);
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
      const meeting = await requireMeeting(input.serverId, input.meetingId);
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
