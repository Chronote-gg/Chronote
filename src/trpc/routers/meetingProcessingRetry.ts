import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { GuildSessionCache } from "../../services/guildAccessService";
import { isProcessingRetryAvailable } from "../../services/processingRetryAvailability";
import { projectProcessingRetry } from "../../services/processingRetryEligibility";
import {
  requestProcessingRetry,
  type ProcessingRetryRequestResult,
} from "../../services/processingRetryRequestService";
import type { MeetingHistory } from "../../types/db";
import {
  PROCESSING_RETRY_EXPLAINED_REASONS,
  type ProcessingRetryView,
} from "../../types/meetingProcessingRetry";
import { authedProcedure } from "../trpc";
import {
  ensurePortalUserCanEditMeetingNotes,
  getMeetingOrThrow,
  parseChannelIdTimestamp,
} from "./meetingEditPermissions";

const FORBIDDEN_MESSAGE =
  "Only the meeting starter can retry processing for this meeting.";

type RetryUser = { id: string; accessToken?: string };
type RetryRejection = Exclude<ProcessingRetryRequestResult, { kind: "queued" }>;

function rejectionError(result: RetryRejection): TRPCError {
  if (result.kind === "unavailable")
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Processing retry is not available yet.",
    });
  if (result.kind === "conflict")
    return new TRPCError({
      code: "CONFLICT",
      message: "The meeting changed. Refresh and try again.",
    });
  if (result.reason === "replace_confirmation_required")
    return new TRPCError({
      code: "BAD_REQUEST",
      message: "Confirm replacing the existing notes to retry.",
    });
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "This meeting cannot be retried right now.",
  });
}

function ensureUserCanRetry(input: {
  history: MeetingHistory;
  serverId: string;
  channelId: string;
  user: RetryUser;
  session?: GuildSessionCache;
}): Promise<void> {
  return ensurePortalUserCanEditMeetingNotes({
    accessToken: input.user.accessToken,
    guildId: input.serverId,
    meeting: input.history,
    channelId: input.channelId,
    session: input.session,
    userId: input.user.id,
    forbiddenMessage: FORBIDDEN_MESSAGE,
  });
}

/** A malformed stored row must not fail the whole meeting load. */
function projectReadableRetry(history: MeetingHistory): ProcessingRetryView {
  try {
    return projectProcessingRetry(history);
  } catch (error) {
    console.warn("Unreadable processing retry state", {
      guildId: history.guildId,
      channelIdTimestamp: history.channelId_timestamp,
      error,
    });
    return projectProcessingRetry(history, "unavailable");
  }
}

/** Non-editors see no retry UI and no job state. */
const NOT_PERMITTED_VIEW: ProcessingRetryView = {
  eligible: false,
  reason: "not_permitted",
  requiresReplaceConfirm: false,
  attemptsRemaining: 0,
};

const EXPLAINED_REASONS: ReadonlySet<string> = new Set(
  PROCESSING_RETRY_EXPLAINED_REASONS,
);

function viewShowsAnything(view: ProcessingRetryView): boolean {
  return (
    view.eligible ||
    view.status !== undefined ||
    EXPLAINED_REASONS.has(view.reason ?? "")
  );
}

/** A config read error must not fail the whole meeting load. */
async function readAvailability(): Promise<boolean> {
  try {
    return await isProcessingRetryAvailable();
  } catch (error) {
    console.warn("Could not read processing retry availability", error);
    return false;
  }
}

export async function resolveProcessingRetryView(input: {
  history: MeetingHistory;
  serverId: string;
  channelId: string;
  user: RetryUser;
  session?: GuildSessionCache;
}): Promise<ProcessingRetryView> {
  const view = (await readAvailability())
    ? projectReadableRetry(input.history)
    : projectProcessingRetry(input.history, "unavailable");
  if (!viewShowsAnything(view)) return view;
  try {
    await ensureUserCanRetry(input);
    return view;
  } catch (error) {
    // A Discord rate limit or a denial hides the action instead of failing the page.
    if (error instanceof TRPCError) return NOT_PERMITTED_VIEW;
    throw error;
  }
}

export const retryProcessing = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      replaceNotes: z.boolean().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await getMeetingOrThrow(input.serverId, input.meetingId);
    await ensureUserCanRetry({
      history,
      serverId: input.serverId,
      channelId:
        history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId,
      user: ctx.user,
      session: ctx.req.session,
    });
    const result = await requestProcessingRetry({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      requestedBy: ctx.user.id,
      replaceNotes: input.replaceNotes ?? false,
      source: "portal",
    });
    if (result.kind !== "queued") throw rejectionError(result);
    return { processingRetry: projectProcessingRetry(result.history) };
  });
