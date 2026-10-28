import { updateMeeting } from "../../services/meetingUpdateService";
import { approvedCorrectionMutation } from "../../services/approvedMeetingCorrection";
import { projectMeetingUpdateDelivery } from "../../services/meetingUpdateStatus";
import { firstMeeting } from "./firstMeeting";
import { requireBotInGuild } from "./ensureBotPresence";

import {
  projectMeetingCapture,
  resolveCaptureStatus,
} from "../../utils/meetingCaptureNotice";
import { TRPCError } from "@trpc/server";
import { formatHunkDiff } from "../../utils/diff";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import quillDeltaToMarkdownModule from "quill-delta-to-markdown";
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
  updateMeetingArchiveService,
  updateMeetingAccessGrantsService,
} from "../../services/meetingHistoryService";
import {
  ensureManageGuildWithUserToken,
  type GuildSessionCache,
} from "../../services/guildAccessService";
import {
  listMcpMyMeetings,
  McpMeetingAccessError,
} from "../../services/mcpMeetingService";
import { config } from "../../services/configService";
import {
  createNotesCorrectionTokenStore,
  type NotesCorrectionTokenRecord,
} from "../../services/notesCorrectionTokenStore";
import { createDictionaryTeachingTokenStore } from "../../services/dictionaryTeachingTokenStore";
import {
  boundDictionaryTeachingNotesDiff,
  selectDictionaryTeachingTranscriptExcerpt,
} from "../../services/dictionaryTeachingContextService";
import { DICTIONARY_TEACHING_TOKEN_TTL_MS } from "../../types/dictionaryTeaching";
import { buildMeetingTimelineEventsFromHistory } from "../../services/meetingTimelineService";
import {
  fetchJsonFromS3,
  getSignedObjectUrl,
} from "../../services/storageService";
import { getMeetingSummaryFeedback } from "../../services/summaryFeedbackService";
import { isDiscordApiError } from "../../services/discordService";
import {
  listBotGuildsCached,
  listGuildChannelsCached,
} from "../../services/discordCacheService";
import {
  MEETING_NAME_REQUIREMENTS,
  normalizeMeetingName,
  resolveUniqueMeetingName,
} from "../../services/meetingNameService";

import { generateMeetingSummaries } from "../../services/meetingSummaryService";
import { generateOpenAIText } from "../../services/openaiTextService";
import { getLangfuseChatPrompt } from "../../services/langfusePromptService";
import {
  buildModelOverrides,
  getModelChoice,
} from "../../services/modelFactory";
import {
  resolveChatParamsForRole,
  resolveModelParamsForContext,
} from "../../services/openaiModelParams";
import { resolveModelChoicesForContext } from "../../services/modelChoiceService";
import type { ChatEntry } from "../../types/chat";
import type {
  MeetingAccessGrant,
  MeetingHistory,
  SuggestionHistoryEntry,
} from "../../types/db";
import type { MeetingEvent } from "../../types/meetingTimeline";

import type { TranscriptPayload } from "../../types/transcript";
import { MEETING_STATUS } from "../../types/meetingLifecycle";

import { stripCodeFences } from "../../utils/text";
import {
  collectMentionIds,
  mergeAllowedMentions,
  stripUnknownMentions,
} from "../../utils/mentionSanitizer";
import { buildMentionRosters } from "../../services/mentionRosterService";
import {
  buildImportedMeetingNotes,
  normalizeImportedNotes,
} from "../../utils/importedNotes";
import { resolveMeetingAttendees } from "../../services/meetingSharePayloadService";
import {
  buildMeetingMentionReplacer,
  createMeetingMentionReplacer,
  resolveGuildRoleNames,
  resolveMentionsInTimelineEvents,
} from "../../services/meetingMentionService";
import {
  isPersonalMeeting,
  PERSONAL_MEETING_CHANNEL_NAME,
  resolveMeetingOwnerUserId,
} from "../../utils/meetingOwnership";
import { ensureUserCanAccessMeeting } from "../../services/meetingAccessService";
import {
  ensurePortalUserCanAccessMeeting,
  ensurePortalUserCanEditMeetingNotes,
  ensurePortalUserCanManageMeetingChannel,
  parseChannelIdTimestamp,
} from "./meetingEditPermissions";
import { resolveAttendeeAccessEnabled } from "../../services/attendeeAccessSetting";
import {
  resolveProcessingRetryView,
  retryProcessing,
} from "./meetingProcessingRetry";
import {
  authedProcedure,
  correctionProcedure,
  guildMemberProcedure,
  router,
} from "../trpc";
import {
  resolveMeetingArtifactAccess,
  resolveServerMeetingArtifactAccess,
} from "../../services/meetingArtifactAccessService";

const NOTES_CORRECTION_DIFF_LINE_LIMIT = 600;
const NOTES_CORRECTION_DIFF_CHAR_LIMIT = 12_000;

// DynamoDB item size is capped at 400KB. Notes are also versioned in MeetingHistory,
// so we keep portal-edited notes bounded to avoid update failures.
const NOTES_EDITOR_MARKDOWN_BYTE_LIMIT = 30_000;
const NOTES_EDITOR_DELTA_JSON_BYTE_LIMIT = 80_000;
const IMPORT_NOTES_SOURCE_NAME_LIMIT = 100;
const IMPORT_NOTES_SOURCE_URL_LIMIT = 2048;
const PERSONAL_SHARE_TARGET_ID_PATTERN = /^\d{5,25}$/;
const PERSONAL_SHARE_TARGET_LIMIT = 50;

const isHttpSourceUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const importNotesSourceUrlSchema = z
  .string()
  .max(IMPORT_NOTES_SOURCE_URL_LIMIT)
  .url()
  .refine(isHttpSourceUrl, {
    message: "Source URL must start with http:// or https://",
  });

const safeJsonStringifyByteLength = (value: unknown): number | null => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
};

const utf8ByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

const extractQuillDeltaOps = (delta: unknown): unknown[] | null => {
  if (Array.isArray(delta)) return delta;
  if (delta && typeof delta === "object") {
    const maybeOps = (delta as { ops?: unknown }).ops;
    if (Array.isArray(maybeOps)) return maybeOps;
  }
  return null;
};

const quillDeltaToMarkdown = (delta: unknown): string => {
  const ops = extractQuillDeltaOps(delta);
  if (!ops) {
    throw new Error("Invalid quill delta format");
  }
  const markdown = quillDeltaToMarkdownModule.deltaToMarkdown(ops);
  if (typeof markdown !== "string") {
    throw new Error("deltaToMarkdown returned non-string");
  }
  return markdown.trim();
};

const NOTES_CORRECTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const NOTES_CORRECTION_MAX_PENDING = 200;

const notesCorrectionTokenStore = createNotesCorrectionTokenStore({
  maxPending: NOTES_CORRECTION_MAX_PENDING,
});
const dictionaryTeachingTokenStore = createDictionaryTeachingTokenStore({
  maxPending: NOTES_CORRECTION_MAX_PENDING,
});

const resolveGuildAndChannelNamesForPrompt = async (options: {
  guildId: string;
  channelId: string;
}): Promise<{ serverName: string; channelName: string }> => {
  const [guilds, channels] = await Promise.all([
    listBotGuildsCached(),
    listGuildChannelsCached(options.guildId),
  ]);
  const serverName =
    guilds.find((guild) => guild.id === options.guildId)?.name ??
    options.guildId;
  const channelName =
    channels.find((channel) => channel.id === options.channelId)?.name ??
    options.channelId;
  return { serverName, channelName };
};

const ensurePersonalMeetingOwner = (options: {
  meeting: MeetingHistory;
  userId: string;
}) => {
  if (!isPersonalMeeting(options.meeting)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Personal meeting required.",
    });
  }
  if (resolveMeetingOwnerUserId(options.meeting) !== options.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the meeting owner can manage personal sharing.",
    });
  }
};

const buildPersonalAccessGrants = (input: {
  userIds: string[];
  guildIds: string[];
  sharedByUserId: string;
}): MeetingAccessGrant[] => {
  const sharedAt = new Date().toISOString();
  return [
    ...Array.from(new Set(input.userIds)).map((userId) => ({
      targetType: "user" as const,
      userId,
      role: "viewer" as const,
      sharedAt,
      sharedByUserId: input.sharedByUserId,
    })),
    ...Array.from(new Set(input.guildIds)).map((guildId) => ({
      targetType: "guild" as const,
      guildId,
      role: "viewer" as const,
      sharedAt,
      sharedByUserId: input.sharedByUserId,
    })),
  ];
};

const ensurePortalUserCanManageMeetingMetadata = async (params: {
  accessToken?: string;
  guildId: string;
  meeting: MeetingHistory;
  session?: GuildSessionCache;
  userId: string;
}) => {
  if (isPersonalMeeting(params.meeting)) {
    if (resolveMeetingOwnerUserId(params.meeting) === params.userId) {
      return;
    }
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the meeting owner can manage this meeting.",
    });
  }

  const allowed = await ensureManageGuildWithUserToken(
    params.accessToken,
    params.guildId,
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
      message: "Manage Server permission required for this meeting.",
    });
  }
};

const cleanupExpiredPendingNotesCorrections = () => {
  notesCorrectionTokenStore.cleanup();
};

const buildUnifiedDiffForUi = (current: string, proposed: string): string =>
  formatHunkDiff(current, proposed, {
    charLimit: NOTES_CORRECTION_DIFF_CHAR_LIMIT,
    lineLimit: NOTES_CORRECTION_DIFF_LINE_LIMIT,
  });

const formatSuggestionsForPrompt = (suggestions?: SuggestionHistoryEntry[]) => {
  if (!suggestions || suggestions.length === 0) {
    return "None recorded yet.";
  }
  return suggestions
    .map((entry) => {
      const label = entry.displayName || entry.userTag || entry.userId;
      return `- [${new Date(entry.createdAt).toISOString()}] ${label}: ${entry.text}`;
    })
    .join("\n");
};

const buildRequesterTag = (user: {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
}) => {
  const username = user.username ?? user.id ?? "unknown";
  const discriminator = user.discriminator;
  if (discriminator && discriminator !== "0") {
    return `${username}#${discriminator}`;
  }
  return username;
};

async function generateCorrectedNotes(options: {
  signal?: AbortSignal;
  currentNotes: string;
  transcript: string;
  suggestion: string;
  requesterTag: string;
  /** Supplies the rosters, so a correction can add a mention rather than a bare name. */
  meeting: Pick<MeetingHistory, "guildId" | "ownershipScope" | "participants">;
  previousSuggestions?: SuggestionHistoryEntry[];
  modelParams?: Parameters<typeof resolveChatParamsForRole>[0]["config"];
  modelOverride?: string;
}): Promise<string> {
  options.signal?.throwIfAborted();
  const priorSuggestions = formatSuggestionsForPrompt(
    options.previousSuggestions,
  );
  const rosters = await buildMentionRosters(options.meeting);
  options.signal?.throwIfAborted();
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesCorrectionPromptName,
    variables: {
      currentNotes: options.currentNotes,
      priorSuggestions,
      transcript: options.transcript,
      requesterTag: options.requesterTag,
      suggestion: options.suggestion,
      participantRoster: rosters.participantRoster,
      roles: rosters.roles,
    },
  });

  try {
    const modelChoice = getModelChoice(
      "notesCorrection",
      buildModelOverrides(
        options.modelOverride
          ? { notesCorrection: options.modelOverride }
          : undefined,
      ),
    );
    const chatParams = resolveChatParamsForRole({
      role: "notesCorrection",
      model: modelChoice.model,
      config: options.modelParams,
    });
    options.signal?.throwIfAborted();
    const content = await generateOpenAIText({
      model: modelChoice.model,
      input: messages,
      modelParams: chatParams,
      signal: options.signal,
      tracing: {
        traceName: "notes-correction-web",
        generationName: "notes-correction-web",
        tags: ["feature:notes_correction", "surface:web"],
        metadata: { requesterTag: options.requesterTag },
        langfusePrompt,
      },
    });
    options.signal?.throwIfAborted();

    if (content && content.trim().length > 0) {
      // A correction may keep the mentions already in the notes and may add one
      // the rosters offered, but anything outside both was invented.
      return stripUnknownMentions(
        stripCodeFences(content.trim()),
        mergeAllowedMentions(collectMentionIds(options.currentNotes), {
          userIds: rosters.allowedUserIds,
          roleIds: rosters.allowedRoleIds,
        }),
      );
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Failed to generate a correction proposal. Please try again in a moment.",
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    console.error("Failed to generate corrected notes (web):", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Failed to generate a correction proposal. Please try again in a moment.",
    });
  }
}

type MeetingSummary = Awaited<
  ReturnType<typeof listRecentMeetingsForGuildService>
>[number];

const resolveMeetingListChannelId = (meeting: MeetingSummary): string =>
  meeting.channelId ??
  parseChannelIdTimestamp(meeting.channelId_timestamp).channelId;

const resolveMeetingListChannelName = (
  meeting: MeetingSummary,
  channelMap: Map<string, string>,
  channelId: string,
): string =>
  isPersonalMeeting(meeting)
    ? PERSONAL_MEETING_CHANNEL_NAME
    : (channelMap.get(channelId) ?? channelId);

const resolveMeetingListDuration = (meeting: MeetingSummary): number => {
  const status = meeting.status;
  if (
    status === MEETING_STATUS.IN_PROGRESS ||
    status === MEETING_STATUS.PROCESSING
  ) {
    return Math.max(
      0,
      Math.floor((Date.now() - Date.parse(meeting.timestamp)) / 1000),
    );
  }
  if (status == null && meeting.duration === 0) {
    return Math.max(
      0,
      Math.floor((Date.now() - Date.parse(meeting.timestamp)) / 1000),
    );
  }
  return meeting.duration;
};

const resolveMeetingListTags = (tags: MeetingSummary["tags"]) => tags ?? [];

const resolveMeetingListNotes = (notes: MeetingSummary["notes"]) => notes ?? "";

const resolveMeetingListNotesMessageId = (messageIds: string[] | undefined) =>
  messageIds?.[0];

const list = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      limit: z.number().min(1).max(100).optional(),
      archivedOnly: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
    }),
  )
  .query(async ({ ctx, input }) => {
    await requireBotInGuild(input.serverId);

    const limit = input.limit ?? config.ask.maxMeetings;
    const meetings = await listRecentMeetingsForGuildService(
      input.serverId,
      limit,
      {
        archivedOnly: input.archivedOnly,
        includeArchived: input.includeArchived,
      },
    );

    const attendeeOverrideEnabled = await resolveAttendeeAccessEnabled(
      input.serverId,
    );

    const allowedMeetings = [] as typeof meetings;
    for (const meeting of meetings) {
      const allowed = await ensureUserCanAccessMeeting({
        guildId: input.serverId,
        meeting,
        userId: ctx.user.id,
        attendeeOverrideEnabled,
      });
      if (allowed === null) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Discord rate limited. Please retry.",
        });
      }
      if (allowed) {
        allowedMeetings.push(meeting);
      }
    }

    let channels: Array<{ id: string; name: string; type: number }>;
    try {
      channels = await listGuildChannelsCached(input.serverId);
    } catch (err) {
      if (isDiscordApiError(err) && err.status === 429) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Discord rate limited. Please retry.",
        });
      }
      console.warn("Unable to resolve guild channels for meeting list", err);
      channels = [];
    }
    const channelMap = new Map(
      channels.map((channel) => [channel.id, channel.name]),
    );
    // Library cards derive their summary from notes when no summarySentence
    // exists, so list payloads need the same mention resolution as detail.
    // One role fetch for the whole list, since this endpoint is guild scoped.
    const roleNamesByGuildId = new Map([
      [input.serverId, await resolveGuildRoleNames(input.serverId)],
    ]);
    const artifactAccess = await resolveServerMeetingArtifactAccess(
      input.serverId,
    );

    return {
      meetings: allowedMeetings.map((meeting) => {
        const channelId = resolveMeetingListChannelId(meeting);
        const resolveMentions = buildMeetingMentionReplacer(
          meeting,
          roleNamesByGuildId,
        );
        return {
          ...projectMeetingCapture(meeting),
          status: resolveCaptureStatus(meeting),
          id: meeting.channelId_timestamp,
          meetingId: meeting.meetingId,
          channelId,
          channelName: resolveMeetingListChannelName(
            meeting,
            channelMap,
            channelId,
          ),
          ownershipScope: isPersonalMeeting(meeting) ? "personal" : "guild",
          ownerUserId: meeting.ownerUserId,
          timestamp: meeting.timestamp,
          duration: resolveMeetingListDuration(meeting),
          tags: resolveMeetingListTags(meeting.tags),
          notes: resolveMentions.toText(resolveMeetingListNotes(meeting.notes)),
          meetingName: meeting.meetingName,
          summarySentence: meeting.summarySentence
            ? resolveMentions.toText(meeting.summarySentence)
            : meeting.summarySentence,
          summaryLabel: meeting.summaryLabel,
          notesChannelId: meeting.notesChannelId,
          notesMessageId: resolveMeetingListNotesMessageId(
            meeting.notesMessageIds,
          ),
          audioAvailable:
            artifactAccess.audioAccessEnabled && Boolean(meeting.audioS3Key),
          transcriptAvailable:
            artifactAccess.transcriptAccessEnabled &&
            Boolean(meeting.transcriptS3Key),
          archivedAt: meeting.archivedAt,
          archivedByUserId: meeting.archivedByUserId,
        };
      }),
    };
  });

const myList = authedProcedure
  .input(
    z.object({
      mode: z.enum(["attended", "accessible"]).optional(),
      range: z.enum(["all", "today", "past_7_days", "custom"]).optional(),
      limit: z.number().min(1).max(100).optional(),
      cursor: z.string().min(1).optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      timeZoneOffsetMinutes: z
        .number()
        .int()
        .min(-14 * 60)
        .max(14 * 60)
        .optional(),
      serverIds: z.array(z.string().min(1)).optional(),
      tags: z.array(z.string().min(1)).optional(),
      archivedOnly: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
    }),
  )
  .query(async ({ ctx, input }) => {
    try {
      return await listMcpMyMeetings({
        userId: ctx.user.id,
        mode: input.mode,
        range: input.range,
        limit: input.limit,
        cursor: input.cursor,
        startDate: input.startDate,
        endDate: input.endDate,
        timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
        serverIds: input.serverIds,
        tags: input.tags,
        archivedOnly: input.archivedOnly,
        includeArchived: input.includeArchived,
      });
    } catch (error) {
      if (error instanceof McpMeetingAccessError) {
        if (error.code === "rate_limited") {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Discord rate limited. Please retry.",
          });
        }
        if (error.code === "bad_request") {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
      }
      throw error;
    }
  });

const detail = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
    }),
  )
  .query(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const attendeeOverrideEnabled = isPersonalMeeting(history)
      ? true
      : await resolveAttendeeAccessEnabled(input.serverId);

    await ensurePortalUserCanAccessMeeting({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      meeting: history,
      session: ctx.req.session,
      userId: ctx.user.id,
      attendeeOverrideEnabled,
    });

    const channelId =
      history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId;

    let channelName: string;
    if (isPersonalMeeting(history)) {
      channelName = PERSONAL_MEETING_CHANNEL_NAME;
    } else {
      try {
        const channels = await listGuildChannelsCached(input.serverId);
        channelName =
          channels.find((channel) => channel.id === channelId)?.name ??
          channelId;
      } catch (err) {
        if (isDiscordApiError(err) && err.status === 429) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Discord rate limited. Please retry.",
          });
        }
        // If we cannot resolve names, continue with the id.
        channelName = channelId;
      }
    }

    const artifactAccess = await resolveMeetingArtifactAccess(history);
    const transcriptPayload =
      artifactAccess.transcriptAccessEnabled && history.transcriptS3Key
        ? await fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key)
        : undefined;
    const resolveMentions = await createMeetingMentionReplacer(history);
    const transcript = resolveMentions.toText(transcriptPayload?.text ?? "");
    const notes = resolveMentions.toMarkdown(history.notes ?? "");
    const summarySentence = history.summarySentence
      ? // The portal renders this through MarkdownBody, so it needs escaping.
        // It can also feed a title fallback, but only when both meetingName and
        // summaryLabel are absent, and summaryLabel is normalized to
        // alphanumerics so it is almost always present. Escaping the common
        // rendered path beats leaving an injection open for the rare one.
        resolveMentions.toMarkdown(history.summarySentence)
      : history.summarySentence;

    let chatEntries: ChatEntry[] | undefined;
    if (artifactAccess.transcriptAccessEnabled && history.chatS3Key) {
      chatEntries = await fetchJsonFromS3<ChatEntry[]>(history.chatS3Key);
    }
    const events: MeetingEvent[] = artifactAccess.transcriptAccessEnabled
      ? resolveMentionsInTimelineEvents(
          buildMeetingTimelineEventsFromHistory({
            history,
            transcriptPayload,
            chatEntries,
          }),
          resolveMentions.toText,
        )
      : [];

    const audioUrl =
      artifactAccess.audioAccessEnabled && history.audioS3Key
        ? await getSignedObjectUrl(history.audioS3Key)
        : undefined;

    const summaryFeedback = ctx.user
      ? await getMeetingSummaryFeedback({
          channelIdTimestamp: history.channelId_timestamp,
          userId: ctx.user.id,
        })
      : undefined;

    return {
      meeting: {
        ...projectMeetingCapture(history),
        status: resolveCaptureStatus(history),
        id: history.channelId_timestamp,
        meetingId: history.meetingId,
        channelId,
        channelName,
        ownershipScope: isPersonalMeeting(history)
          ? ("personal" as const)
          : ("guild" as const),
        ownerUserId: history.ownerUserId,
        personalShareManageable:
          isPersonalMeeting(history) &&
          resolveMeetingOwnerUserId(history) === ctx.user.id,
        timestamp: history.timestamp,
        duration:
          history.status === MEETING_STATUS.IN_PROGRESS ||
          history.status === MEETING_STATUS.PROCESSING ||
          ((history.status === null || history.status === undefined) &&
            history.duration === 0)
            ? Math.max(
                0,
                Math.floor((Date.now() - Date.parse(history.timestamp)) / 1000),
              )
            : history.duration,
        tags: history.tags ?? [],
        notes,
        updateDelivery: projectMeetingUpdateDelivery(history),
        processing: history.processing,
        processingRetry: await resolveProcessingRetryView({
          history,
          serverId: input.serverId,
          channelId,
          user: ctx.user,
          session: ctx.req.session,
        }),
        notesDelta: history.notesDelta,
        notesVersion: history.notesVersion ?? 1,
        meetingName: history.meetingName,
        summarySentence,
        summaryLabel: history.summaryLabel,
        notesChannelId: history.notesChannelId,
        notesMessageId: history.notesMessageIds?.[0],
        transcript,
        transcriptAccessEnabled: artifactAccess.transcriptAccessEnabled,
        audioUrl,
        audioAccessEnabled: artifactAccess.audioAccessEnabled,
        archivedAt: history.archivedAt,
        archivedByUserId: history.archivedByUserId,
        summaryFeedback: summaryFeedback?.rating,
        attendees: resolveMeetingAttendees(history),
        events,
      },
    };
  });

const updateNotes = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      delta: z
        .object({
          ops: z.array(z.unknown()),
        })
        .passthrough(),
      expectedPreviousVersion: z.number().min(1),
    }),
  )
  .mutation(async function updateNotesMutation({ ctx, input }) {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const channelId =
      history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId;
    await ensurePortalUserCanEditMeetingNotes({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      meeting: history,
      channelId,
      session: ctx.req.session,
      userId: ctx.user.id,
      forbiddenMessage:
        "Only the meeting starter can edit notes for this meeting.",
    });

    const currentVersion = history.notesVersion ?? 1;
    const expectedVersion = input.expectedPreviousVersion;
    if (expectedVersion !== currentVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Could not save because the notes were updated elsewhere. Refresh and try again.",
      });
    }

    const deltaSize = safeJsonStringifyByteLength(input.delta);
    if (deltaSize === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Notes content could not be parsed.",
      });
    }

    if (deltaSize > NOTES_EDITOR_DELTA_JSON_BYTE_LIMIT) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Notes content is too large to save.",
      });
    }

    let markdownNotes: string;
    try {
      markdownNotes = quillDeltaToMarkdown(input.delta);
    } catch (error) {
      console.warn("Failed to convert quill delta to markdown", error);
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Unable to convert notes to Markdown. Try removing unsupported formatting and retry.",
      });
    }

    markdownNotes = (await createMeetingMentionReplacer(history)).toMarkdown(
      markdownNotes,
    );

    if (markdownNotes.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Notes cannot be empty.",
      });
    }

    if (utf8ByteLength(markdownNotes) > NOTES_EDITOR_MARKDOWN_BYTE_LIMIT) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Notes are too large to save.",
      });
    }

    const saved = await updateMeeting({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      mutation: {
        kind: "notes",
        notes: markdownNotes,
        notesDelta: input.delta,
      },
      actor: { editedBy: ctx.user.id },
      notesEdit: {
        expectedNotesVersion: expectedVersion,
        source: { type: "web_editor" },
      },
    });
    if (saved.kind === "conflict")
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Could not save because the notes were updated elsewhere. Refresh and try again.",
      });
    return { ok: true, kind: saved.kind, delivery: saved.delivery };
  });

const importNotes = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      notes: z.string().min(1).max(NOTES_EDITOR_MARKDOWN_BYTE_LIMIT),
      mode: z.enum(["replace", "append"]),
      sourceName: z.string().max(IMPORT_NOTES_SOURCE_NAME_LIMIT).optional(),
      sourceUrl: importNotesSourceUrlSchema.optional(),
      expectedPreviousVersion: z.number().min(1),
    }),
  )
  .mutation(async function importNotesMutation({ ctx, input }) {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const channelId =
      history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId;
    await ensurePortalUserCanEditMeetingNotes({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      meeting: history,
      channelId,
      session: ctx.req.session,
      userId: ctx.user.id,
      forbiddenMessage:
        "Only the meeting starter can import notes for this meeting.",
    });

    const currentVersion = history.notesVersion ?? 1;
    const expectedVersion = input.expectedPreviousVersion;
    if (expectedVersion !== currentVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Could not import because the notes were updated elsewhere. Refresh and try again.",
      });
    }

    const importedNotes = normalizeImportedNotes(input.notes);
    if (importedNotes.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Imported notes cannot be empty.",
      });
    }

    const source = {
      sourceName: input.sourceName?.trim() || undefined,
      sourceUrl: input.sourceUrl?.trim() || undefined,
    };
    let markdownNotes = buildImportedMeetingNotes({
      currentNotes: history.notes,
      importedNotes,
      mode: input.mode,
      source,
    });

    markdownNotes = (await createMeetingMentionReplacer(history)).toMarkdown(
      markdownNotes,
    );

    if (utf8ByteLength(markdownNotes) > NOTES_EDITOR_MARKDOWN_BYTE_LIMIT) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Imported notes are too large to save.",
      });
    }

    const saved = await updateMeeting({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      mutation: { kind: "notes", notes: markdownNotes, notesDelta: null },
      actor: { editedBy: ctx.user.id },
      notesEdit: {
        expectedNotesVersion: expectedVersion,
        source: {
          type: "manual_import",
          importMode: input.mode,
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
        },
      },
    });
    if (saved.kind === "conflict")
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Could not import because the notes were updated elsewhere. Refresh and try again.",
      });
    return { ok: true, kind: saved.kind, delivery: saved.delivery };
  });

const setArchived = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      archived: z.boolean(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    await ensurePortalUserCanManageMeetingMetadata({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      meeting: history,
      session: ctx.req.session,
      userId: ctx.user.id,
    });

    const ok = await updateMeetingArchiveService({
      guildId: input.serverId,
      channelId_timestamp: input.meetingId,
      archived: input.archived,
      archivedByUserId: ctx.user.id,
    });
    if (!ok) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    return { ok: true };
  });

const rename = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      meetingName: z.string().min(1).max(60),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    await ensurePortalUserCanManageMeetingMetadata({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      meeting: history,
      session: ctx.req.session,
      userId: ctx.user.id,
    });

    const normalized = normalizeMeetingName(input.meetingName);
    if (!normalized) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: MEETING_NAME_REQUIREMENTS,
      });
    }
    const meetingName = await resolveUniqueMeetingName({
      guildId: input.serverId,
      desiredName: normalized,
      excludeMeetingId: history.meetingId,
    });
    const saved = await updateMeeting({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      mutation: { kind: "rename", meetingName },
      actor: { editedBy: ctx.user.id },
    });
    if (saved.kind === "conflict")
      throw new TRPCError({
        code: "CONFLICT",
        message: "Meeting changed. Refresh and try again.",
      });
    return { meetingName, kind: saved.kind, delivery: saved.delivery };
  });

const suggestNotesCorrection = correctionProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      suggestion: z.string().min(1).max(1500),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await ctx.operation.read(() =>
      getMeetingHistoryService(input.serverId, input.meetingId),
    );
    if (!history || !history.notes) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Meeting notes not found",
      });
    }

    const channelId =
      history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId;
    const attendeeOverrideEnabled = isPersonalMeeting(history)
      ? true
      : await ctx.operation.read(() =>
          resolveAttendeeAccessEnabled(input.serverId),
        );
    await ctx.operation.read(() =>
      ensurePortalUserCanAccessMeeting({
        accessToken: ctx.user.accessToken,
        guildId: input.serverId,
        meeting: history,
        session: ctx.req.session,
        userId: ctx.user.id,
        attendeeOverrideEnabled,
      }),
    );

    const transcriptPayload = history.transcriptS3Key
      ? await ctx.operation.read(() =>
          fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key!),
        )
      : undefined;
    const transcript = transcriptPayload?.text ?? "";

    const requesterTag = buildRequesterTag(ctx.user);
    const correctionId = uuidv4();
    const baseNotesVersion = history.notesVersion ?? 1;
    const suggestionEntry: SuggestionHistoryEntry = {
      correctionId,
      userId: ctx.user.id,
      userTag: requesterTag,
      displayName: ctx.user.username ?? requesterTag,
      text: input.suggestion,
      createdAt: new Date().toISOString(),
      source: "web",
      baseNotesVersion,
    };

    const modelParams = await ctx.operation.read(() =>
      resolveModelParamsForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      }),
    );
    const modelChoices = await ctx.operation.read(() =>
      resolveModelChoicesForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      }),
    );

    const newNotes = await ctx.operation.read(() =>
      generateCorrectedNotes({
        signal: ctx.operation.signal,
        currentNotes: history.notes!,
        transcript,
        suggestion: input.suggestion,
        requesterTag,
        meeting: history,
        previousSuggestions: history.suggestionsHistory,
        modelParams: modelParams.notesCorrection,
        modelOverride: modelChoices.notesCorrection,
      }),
    );

    cleanupExpiredPendingNotesCorrections();
    const diff = buildUnifiedDiffForUi(history.notes, newNotes);
    const notesDiff = boundDictionaryTeachingNotesDiff(diff);
    const transcriptExcerpt = selectDictionaryTeachingTranscriptExcerpt({
      transcript,
      instruction: input.suggestion,
      notesDiff,
    });
    const token = uuidv4();
    const expiresAtMs = Date.now() + NOTES_CORRECTION_TOKEN_TTL_MS;
    const record: NotesCorrectionTokenRecord = {
      guildId: input.serverId,
      meetingId: input.meetingId,
      correctionId,
      expiresAtMs,
      notesVersion: baseNotesVersion,
      requesterId: ctx.user.id,
      newNotes,
      suggestion: suggestionEntry,
      notesDiff,
      transcriptExcerpt,
    };
    await ctx.operation.mutate(() =>
      notesCorrectionTokenStore.set(token, record),
    );

    return {
      token,
      diff: newNotes.trim() !== history.notes.trim() ? diff : "",
      changed: newNotes.trim() !== history.notes.trim(),
    };
  });

const applyNotesCorrection = correctionProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      token: z.string().min(1).max(128),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    cleanupExpiredPendingNotesCorrections();
    const pending = await ctx.operation.read(() =>
      notesCorrectionTokenStore.get(input.token),
    );
    if (!pending) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This correction request has expired.",
      });
    }
    if (
      pending.guildId !== input.serverId ||
      pending.meetingId !== input.meetingId
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Correction request does not match meeting.",
      });
    }

    const history = await ctx.operation.read(() =>
      getMeetingHistoryService(input.serverId, input.meetingId),
    );
    if (!history) {
      await ctx.operation.mutate(() =>
        notesCorrectionTokenStore.delete(input.token),
      );
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const channelId =
      history.channelId ?? parseChannelIdTimestamp(input.meetingId).channelId;
    const attendeeOverrideEnabled = isPersonalMeeting(history)
      ? true
      : await ctx.operation.read(() =>
          resolveAttendeeAccessEnabled(input.serverId),
        );
    await ctx.operation.read(() =>
      ensurePortalUserCanAccessMeeting({
        accessToken: ctx.user.accessToken,
        guildId: input.serverId,
        meeting: history,
        session: ctx.req.session,
        userId: ctx.user.id,
        attendeeOverrideEnabled,
      }),
    );

    const isMeetingOwner = resolveMeetingOwnerUserId(history) === ctx.user.id;
    const isRequester = pending.requesterId === ctx.user.id;

    if (!isMeetingOwner && !isRequester) {
      if (history.isAutoRecording) {
        await ctx.operation.read(() =>
          ensurePortalUserCanManageMeetingChannel({
            guildId: input.serverId,
            channelId,
            userId: ctx.user.id,
          }),
        );
      } else {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the meeting starter can apply corrections for this meeting.",
        });
      }
    }

    const newVersion = (pending.notesVersion ?? 1) + 1;
    const correctionId = pending.correctionId ?? uuidv4();
    const appliedSuggestion: SuggestionHistoryEntry = {
      ...pending.suggestion,
      correctionId,
      source: "web",
      baseNotesVersion: pending.notesVersion,
      resultingNotesVersion: newVersion,
    };

    // Generate summaries before any mutations
    const { serverName, channelName } = await ctx.operation.read(() =>
      resolveGuildAndChannelNamesForPrompt({
        guildId: input.serverId,
        channelId,
      }),
    );
    const summaryModelParams = await ctx.operation.read(() =>
      resolveModelParamsForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      }),
    );
    const summaryModelChoices = await ctx.operation.read(() =>
      resolveModelChoicesForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      }),
    );
    const meetingDate = history.timestamp
      ? new Date(history.timestamp)
      : new Date();
    const summaries = await ctx.operation.read(() =>
      generateMeetingSummaries({
        signal: ctx.operation.signal,
        guildId: input.serverId,
        notes: pending.newNotes,
        serverName,
        channelName,
        tags: history.tags,
        now: meetingDate,
        meetingId: history.meetingId,
        previousSummarySentence: history.summarySentence,
        previousSummaryLabel: history.summaryLabel,
        modelParams: summaryModelParams.meetingSummary,
        modelOverride: summaryModelChoices.meetingSummary,
      }),
    );
    const summarySentence =
      summaries.summarySentence ?? history.summarySentence;
    const summaryLabel = summaries.summaryLabel ?? history.summaryLabel;

    const saved = await updateMeeting({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      mutation: approvedCorrectionMutation({
        history,
        notes: pending.newNotes,
        summarySentence,
        summaryLabel,
      }),
      actor: { editedBy: ctx.user.id },
      notesEdit: {
        expectedNotesVersion: pending.notesVersion,
        source: { type: "notes_correction", correctionId },
        suggestion: appliedSuggestion,
      },
      signal: ctx.operation.signal,
      operation: ctx.operation,
    });
    if (saved.kind === "conflict") {
      await ctx.operation.mutate(() =>
        notesCorrectionTokenStore.delete(input.token),
      );
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Could not apply this correction because the notes were updated elsewhere. Please regenerate the correction and try again.",
      });
    }

    let dictionaryTeachingContextToken: string | undefined;
    let dictionaryTeachingContextExpiresAtMs: number | undefined;
    const [canTeachDictionary, artifactAccess] = await Promise.all([
      ensureManageGuildWithUserToken(ctx.user.accessToken, input.serverId, {
        session: ctx.req.session,
        userId: ctx.user.id,
      }),
      resolveMeetingArtifactAccess(history).catch((error) => {
        console.warn(
          "Failed resolving transcript access for dictionary teaching context",
          error,
        );
        return null;
      }),
    ]);
    const teachingTranscriptExcerpt = artifactAccess?.transcriptAccessEnabled
      ? pending.transcriptExcerpt
      : undefined;
    if (
      canTeachDictionary === true &&
      (pending.notesDiff || teachingTranscriptExcerpt)
    ) {
      try {
        dictionaryTeachingContextToken = uuidv4();
        dictionaryTeachingContextExpiresAtMs =
          Date.now() + DICTIONARY_TEACHING_TOKEN_TTL_MS;
        await ctx.operation.mutate(() =>
          dictionaryTeachingTokenStore.setContext(
            dictionaryTeachingContextToken!,
            {
              guildId: input.serverId,
              requesterId: ctx.user.id,
              expiresAtMs: dictionaryTeachingContextExpiresAtMs!,
              context: {
                source: "notes_correction",
                meetingId: input.meetingId,
                correctionId,
                notesDiff: pending.notesDiff,
                transcriptExcerpt: teachingTranscriptExcerpt,
              },
            },
          ),
        );
      } catch (error) {
        ctx.operation.signal.throwIfAborted();
        dictionaryTeachingContextToken = undefined;
        dictionaryTeachingContextExpiresAtMs = undefined;
        console.warn(
          "Failed creating dictionary teaching context after correction",
          error,
        );
      }
    }

    await ctx.operation.mutate(() =>
      notesCorrectionTokenStore.delete(input.token),
    );
    return {
      ok: true,
      kind: saved.kind,
      delivery: saved.delivery,
      dictionaryTeachingContextToken,
      dictionaryTeachingContextExpiresAtMs,
      dictionaryTeachingInstruction: appliedSuggestion.text,
    };
  });

const personalShareState = authedProcedure
  .input(z.object({ serverId: z.string(), meetingId: z.string() }))
  .query(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    ensurePersonalMeetingOwner({ meeting: history, userId: ctx.user.id });
    return {
      accessGrants: history.accessGrants ?? [],
    };
  });

const setPersonalShareGrants = authedProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      userIds: z
        .array(z.string().regex(PERSONAL_SHARE_TARGET_ID_PATTERN))
        .max(PERSONAL_SHARE_TARGET_LIMIT),
      guildIds: z
        .array(z.string().regex(PERSONAL_SHARE_TARGET_ID_PATTERN))
        .max(PERSONAL_SHARE_TARGET_LIMIT),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    ensurePersonalMeetingOwner({ meeting: history, userId: ctx.user.id });
    const accessGrants = buildPersonalAccessGrants({
      userIds: input.userIds,
      guildIds: input.guildIds,
      sharedByUserId: ctx.user.id,
    });
    const ok = await updateMeetingAccessGrantsService({
      guildId: input.serverId,
      channelId_timestamp: input.meetingId,
      accessGrants,
    });
    if (!ok) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    return { accessGrants };
  });

export const meetingsRouter = router({
  firstMeeting,
  list,
  myList,
  detail,
  personalShareState,
  setPersonalShareGrants,
  setArchived,
  rename,
  suggestNotesCorrection,
  applyNotesCorrection,
  updateNotes,
  importNotes,
  retryProcessing,
});
