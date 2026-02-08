import { TRPCError } from "@trpc/server";
import { diffLines } from "diff";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
  updateMeetingNotesService,
  updateMeetingArchiveService,
  updateMeetingNameService,
} from "../../services/meetingHistoryService";
import { ensureBotInGuild } from "../../services/guildAccessService";
import { config } from "../../services/configService";
import {
  createNotesCorrectionTokenStore,
  type NotesCorrectionTokenRecord,
} from "../../services/notesCorrectionTokenStore";
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
import { updateMeetingNotesEmbedTitles } from "../../services/meetingNotesEmbedService";
import {
  createDiscordMessage,
  deleteDiscordMessage,
  fetchDiscordMessage,
  updateDiscordMessageEmbeds,
} from "../../services/discordMessageService";
import { generateMeetingSummaries } from "../../services/meetingSummaryService";
import { createOpenAIClient } from "../../services/openaiClient";
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
import type { SuggestionHistoryEntry } from "../../types/db";
import type { MeetingEvent } from "../../types/meetingTimeline";
import type { Participant } from "../../types/participants";
import type { TranscriptPayload } from "../../types/transcript";
import { MEETING_STATUS } from "../../types/meetingLifecycle";
import { buildMeetingNotesEmbeds } from "../../utils/meetingNotes";
import { stripCodeFences } from "../../utils/text";
import {
  replaceDiscordMentionsWithDisplayNames,
  resolveAttendeeDisplayName,
} from "../../utils/participants";
import {
  ensureUserCanManageChannel,
  ensureUserCanViewChannel,
} from "../../services/discordPermissionsService";
import { guildMemberProcedure, manageGuildProcedure, router } from "../trpc";

const resolveParticipantLabel = (participant: Participant) =>
  participant.serverNickname ||
  participant.displayName ||
  participant.username ||
  participant.tag ||
  "Unknown";

const buildParticipantMap = (participants?: Participant[]) =>
  new Map(
    (participants ?? []).map((participant) => [participant.id, participant]),
  );

const resolveMeetingAttendees = (history: {
  participants?: Participant[];
  attendees?: string[];
}) => {
  const participants = buildParticipantMap(history.participants);
  if (history.attendees?.length) {
    return history.attendees.map((attendee) =>
      resolveAttendeeDisplayName(attendee, participants),
    );
  }
  if (history.participants?.length) {
    return history.participants.map((participant) =>
      resolveParticipantLabel(participant),
    );
  }
  return [];
};

const NOTES_CORRECTION_DIFF_LINE_LIMIT = 600;
const NOTES_CORRECTION_DIFF_CHAR_LIMIT = 12_000;
const NOTES_CORRECTION_MAX_EMBEDS_PER_MESSAGE = 10;

const NOTES_CORRECTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const NOTES_CORRECTION_MAX_PENDING = 200;

const notesCorrectionTokenStore = createNotesCorrectionTokenStore({
  maxPending: NOTES_CORRECTION_MAX_PENDING,
});

const SUMMARY_DEFAULT_TITLE = "Meeting Summary";
const SUMMARY_EMPTY_DESCRIPTION = "Summary unavailable.";

const resolveSummaryTitle = (options: {
  meetingName?: string;
  summaryLabel?: string;
}) => {
  const name = options.meetingName?.trim();
  if (name) return name;
  const label = options.summaryLabel?.trim();
  if (label) return label;
  return SUMMARY_DEFAULT_TITLE;
};

const resolveSummaryDescription = (options: {
  summarySentence?: string;
  summaryLabel?: string;
}) => {
  const summary =
    options.summarySentence?.trim() ?? options.summaryLabel?.trim();
  if (summary && summary.length > 0) return summary;
  return SUMMARY_EMPTY_DESCRIPTION;
};

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

const ensurePortalUserCanViewMeetingChannel = async (options: {
  guildId: string;
  channelId: string;
  userId: string;
}) => {
  const allowed = await ensureUserCanViewChannel(options);
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Channel access required",
    });
  }
};

const ensurePortalUserCanManageMeetingChannel = async (options: {
  guildId: string;
  channelId: string;
  userId: string;
}) => {
  const allowed = await ensureUserCanManageChannel(options);
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Manage channel permission required",
    });
  }
};

const cleanupExpiredPendingNotesCorrections = () => {
  notesCorrectionTokenStore.cleanup();
};

const trimForUi = (
  content: string,
  limit = NOTES_CORRECTION_DIFF_CHAR_LIMIT,
) => {
  if (content.length <= limit) return content;
  const suffix = `\n... (truncated, ${content.length}/${limit} chars)`;
  const prefixLength = Math.max(0, limit - suffix.length);
  return content.substring(0, prefixLength) + suffix;
};

const buildUnifiedDiffForUi = (current: string, proposed: string): string => {
  if (current.trim() === proposed.trim()) {
    return "";
  }
  const changes = diffLines(current, proposed);
  const lines: string[] = [];

  for (const change of changes) {
    if (!change.added && !change.removed) {
      continue;
    }
    const prefix = change.added ? "+" : "-";
    const content = change.value.split("\n");
    for (let i = 0; i < content.length; i += 1) {
      const line = content[i];
      const isLast = i === content.length - 1;
      // `split("\n")` produces a synthetic trailing empty element when the
      // string ends with a newline. Skip that, but preserve true blank-line
      // changes so the UI can render a non-empty diff.
      if (isLast && line === "") continue;

      lines.push(line === "" ? `${prefix} ` : `${prefix} ${line}`);
      if (lines.length >= NOTES_CORRECTION_DIFF_LINE_LIMIT) break;
    }
    if (lines.length >= NOTES_CORRECTION_DIFF_LINE_LIMIT) break;
  }

  return trimForUi(lines.join("\n"));
};

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
  currentNotes: string;
  transcript: string;
  suggestion: string;
  requesterTag: string;
  previousSuggestions?: SuggestionHistoryEntry[];
  modelParams?: Parameters<typeof resolveChatParamsForRole>[0]["config"];
  modelOverride?: string;
}): Promise<string> {
  const priorSuggestions = formatSuggestionsForPrompt(
    options.previousSuggestions,
  );
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesCorrectionPromptName,
    variables: {
      currentNotes: options.currentNotes,
      priorSuggestions,
      transcript: options.transcript,
      requesterTag: options.requesterTag,
      suggestion: options.suggestion,
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
    const openAIClient = createOpenAIClient({
      traceName: "notes-correction-web",
      generationName: "notes-correction-web",
      tags: ["feature:notes_correction", "surface:web"],
      metadata: {
        requesterTag: options.requesterTag,
      },
      langfusePrompt,
    });
    const completion = await openAIClient.chat.completions.create({
      model: modelChoice.model,
      messages,
      ...chatParams,
    });

    const content = completion.choices[0]?.message?.content;
    if (content && content.trim().length > 0) {
      return stripCodeFences(content.trim());
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Failed to generate a correction proposal. Please try again in a moment.",
    });
  } catch (error) {
    console.error("Failed to generate corrected notes (web):", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Failed to generate a correction proposal. Please try again in a moment.",
    });
  }
}

async function sendNotesEmbedsToDiscord(params: {
  channelId: string;
  notesBody: string;
  meetingName?: string;
  footerText?: string;
  color?: number;
}): Promise<string[]> {
  const embeds = buildMeetingNotesEmbeds({
    notesBody: params.notesBody,
    meetingName: params.meetingName,
    footerText: params.footerText,
    color: params.color,
  }).map((embed) => embed.toJSON() as unknown as Record<string, unknown>);

  const messageIds: string[] = [];

  try {
    for (
      let i = 0;
      i < embeds.length;
      i += NOTES_CORRECTION_MAX_EMBEDS_PER_MESSAGE
    ) {
      const msg = await createDiscordMessage(params.channelId, {
        embeds: embeds.slice(i, i + NOTES_CORRECTION_MAX_EMBEDS_PER_MESSAGE),
        components: [],
      });
      messageIds.push(msg.id);
    }
    return messageIds;
  } catch (error) {
    if (messageIds.length > 0) {
      await deleteDiscordMessagesSafely({
        channelId: params.channelId,
        messageIds,
      });
    }
    throw error;
  }
}

async function deleteDiscordMessagesSafely(params: {
  channelId: string;
  messageIds: string[];
  skipMessageId?: string;
}) {
  for (const messageId of params.messageIds) {
    if (params.skipMessageId && messageId === params.skipMessageId) {
      continue;
    }
    try {
      await deleteDiscordMessage(params.channelId, messageId);
    } catch (error) {
      console.warn("Failed deleting Discord message", {
        channelId: params.channelId,
        messageId,
        error,
      });
    }
  }
}

const list = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      limit: z.number().min(1).max(100).optional(),
      archivedOnly: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
    }),
  )
  .query(async ({ input }) => {
    const botCheck = await ensureBotInGuild(input.serverId);
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

    const limit = input.limit ?? config.ask.maxMeetings;
    const meetings = await listRecentMeetingsForGuildService(
      input.serverId,
      limit,
      {
        archivedOnly: input.archivedOnly,
        includeArchived: input.includeArchived,
      },
    );

    let channels: Array<{ id: string; name: string; type: number }> = [];
    try {
      channels = await listGuildChannelsCached(input.serverId);
    } catch (err) {
      if (isDiscordApiError(err) && err.status === 429) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Discord rate limited. Please retry.",
        });
      }
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "Unable to fetch guild channels",
      });
    }
    const channelMap = new Map(
      channels.map((channel) => [channel.id, channel.name]),
    );

    return {
      meetings: meetings.map((meeting) => ({
        status: meeting.status ?? MEETING_STATUS.COMPLETE,
        id: meeting.channelId_timestamp,
        meetingId: meeting.meetingId,
        channelId: meeting.channelId,
        channelName: channelMap.get(meeting.channelId) ?? meeting.channelId,
        timestamp: meeting.timestamp,
        duration:
          meeting.status === MEETING_STATUS.IN_PROGRESS ||
          meeting.status === MEETING_STATUS.PROCESSING ||
          ((meeting.status === null || meeting.status === undefined) &&
            meeting.duration === 0)
            ? Math.max(
                0,
                Math.floor((Date.now() - Date.parse(meeting.timestamp)) / 1000),
              )
            : meeting.duration,
        tags: meeting.tags ?? [],
        notes: meeting.notes ?? "",
        meetingName: meeting.meetingName,
        summarySentence: meeting.summarySentence,
        summaryLabel: meeting.summaryLabel,
        notesChannelId: meeting.notesChannelId,
        notesMessageId: meeting.notesMessageIds?.[0],
        audioAvailable: Boolean(meeting.audioS3Key),
        transcriptAvailable: Boolean(meeting.transcriptS3Key),
        archivedAt: meeting.archivedAt,
        archivedByUserId: meeting.archivedByUserId,
      })),
    };
  });

const detail = manageGuildProcedure
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

    const transcriptPayload = history.transcriptS3Key
      ? await fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key)
      : undefined;
    const participants = buildParticipantMap(history.participants);
    const transcript = replaceDiscordMentionsWithDisplayNames(
      transcriptPayload?.text ?? "",
      participants,
    );
    const notes = replaceDiscordMentionsWithDisplayNames(
      history.notes ?? "",
      participants,
    );
    const summarySentence = history.summarySentence
      ? replaceDiscordMentionsWithDisplayNames(
          history.summarySentence,
          participants,
        )
      : history.summarySentence;

    let chatEntries: ChatEntry[] | undefined;
    if (history.chatS3Key) {
      chatEntries = await fetchJsonFromS3<ChatEntry[]>(history.chatS3Key);
    }
    const events: MeetingEvent[] = buildMeetingTimelineEventsFromHistory({
      history,
      transcriptPayload,
      chatEntries,
    });

    const audioUrl = history.audioS3Key
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
        status: history.status ?? MEETING_STATUS.COMPLETE,
        id: history.channelId_timestamp,
        meetingId: history.meetingId,
        channelId: history.channelId,
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
        meetingName: history.meetingName,
        summarySentence,
        summaryLabel: history.summaryLabel,
        notesChannelId: history.notesChannelId,
        notesMessageId: history.notesMessageIds?.[0],
        transcript,
        audioUrl,
        archivedAt: history.archivedAt,
        archivedByUserId: history.archivedByUserId,
        summaryFeedback: summaryFeedback?.rating,
        attendees: resolveMeetingAttendees(history),
        events,
      },
    };
  });

const setArchived = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      archived: z.boolean(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
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

const rename = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      meetingName: z.string().min(1).max(60),
    }),
  )
  .mutation(async ({ input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
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
    const ok = await updateMeetingNameService({
      guildId: input.serverId,
      channelId_timestamp: input.meetingId,
      meetingName,
    });
    if (!ok) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    await updateMeetingNotesEmbedTitles({
      notesChannelId: history.notesChannelId,
      notesMessageIds: history.notesMessageIds,
      meetingName,
    });
    return { meetingName };
  });

const suggestNotesCorrection = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      suggestion: z.string().min(1).max(1500),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history || !history.notes) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Meeting notes not found",
      });
    }

    const channelId = history.channelId ?? input.meetingId.split("#")[0];
    await ensurePortalUserCanViewMeetingChannel({
      guildId: input.serverId,
      channelId,
      userId: ctx.user.id,
    });

    const transcriptPayload = history.transcriptS3Key
      ? await fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key)
      : undefined;
    const transcript = transcriptPayload?.text ?? "";

    const requesterTag = buildRequesterTag(ctx.user);
    const suggestionEntry: SuggestionHistoryEntry = {
      userId: ctx.user.id,
      userTag: requesterTag,
      displayName: ctx.user.username ?? requesterTag,
      text: input.suggestion,
      createdAt: new Date().toISOString(),
    };

    const modelParams = await resolveModelParamsForContext({
      guildId: input.serverId,
      channelId,
      userId: ctx.user.id,
    });
    const modelChoices = await resolveModelChoicesForContext({
      guildId: input.serverId,
      channelId,
      userId: ctx.user.id,
    });

    const newNotes = await generateCorrectedNotes({
      currentNotes: history.notes,
      transcript,
      suggestion: input.suggestion,
      requesterTag,
      previousSuggestions: history.suggestionsHistory,
      modelParams: modelParams.notesCorrection,
      modelOverride: modelChoices.notesCorrection,
    });

    cleanupExpiredPendingNotesCorrections();
    const diff = buildUnifiedDiffForUi(history.notes, newNotes);
    const token = uuidv4();
    const expiresAtMs = Date.now() + NOTES_CORRECTION_TOKEN_TTL_MS;
    const record: NotesCorrectionTokenRecord = {
      guildId: input.serverId,
      meetingId: input.meetingId,
      expiresAtMs,
      notesVersion: history.notesVersion ?? 1,
      requesterId: ctx.user.id,
      newNotes,
      suggestion: suggestionEntry,
    };
    await notesCorrectionTokenStore.set(token, record);

    return {
      token,
      diff: newNotes.trim() !== history.notes.trim() ? diff : "",
      changed: newNotes.trim() !== history.notes.trim(),
    };
  });

const applyNotesCorrection = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      token: z.string().min(1).max(128),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    cleanupExpiredPendingNotesCorrections();
    const pending = await notesCorrectionTokenStore.get(input.token);
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

    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      await notesCorrectionTokenStore.delete(input.token);
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const channelId = history.channelId ?? input.meetingId.split("#")[0];
    await ensurePortalUserCanViewMeetingChannel({
      guildId: input.serverId,
      channelId,
      userId: ctx.user.id,
    });

    const isMeetingOwner =
      Boolean(history.meetingCreatorId) &&
      history.meetingCreatorId === ctx.user.id;
    const isRequester = pending.requesterId === ctx.user.id;

    if (!isMeetingOwner && !isRequester) {
      if (history.isAutoRecording) {
        await ensurePortalUserCanManageMeetingChannel({
          guildId: input.serverId,
          channelId,
          userId: ctx.user.id,
        });
      } else {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the meeting starter can apply corrections for this meeting.",
        });
      }
    }

    const newVersion = (pending.notesVersion ?? 1) + 1;
    const editorLabel = buildRequesterTag(ctx.user);
    const footerText = `v${newVersion} • Edited by ${editorLabel}`;

    let newMessageIds: string[] | undefined;
    let didPersistNewNotes = false;

    try {
      if (!config.mock.enabled && history.notesChannelId) {
        newMessageIds = await sendNotesEmbedsToDiscord({
          channelId: history.notesChannelId,
          notesBody: pending.newNotes,
          meetingName: history.meetingName,
          footerText,
        });
      }

      const { serverName, channelName } =
        await resolveGuildAndChannelNamesForPrompt({
          guildId: input.serverId,
          channelId,
        });
      const summaryModelParams = await resolveModelParamsForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      });
      const summaryModelChoices = await resolveModelChoicesForContext({
        guildId: input.serverId,
        channelId,
        userId: ctx.user.id,
      });
      const meetingDate = history.timestamp
        ? new Date(history.timestamp)
        : new Date();
      const summaries = await generateMeetingSummaries({
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
      });
      const summarySentence =
        summaries.summarySentence ?? history.summarySentence;
      const summaryLabel = summaries.summaryLabel ?? history.summaryLabel;

      const ok = await updateMeetingNotesService({
        guildId: input.serverId,
        channelId_timestamp: input.meetingId,
        notes: pending.newNotes,
        notesVersion: newVersion,
        editedBy: ctx.user.id,
        summarySentence,
        summaryLabel,
        suggestion: pending.suggestion,
        expectedPreviousVersion: pending.notesVersion,
        metadata:
          history.notesChannelId && newMessageIds
            ? {
                notesMessageIds: newMessageIds,
                notesChannelId: history.notesChannelId,
              }
            : undefined,
      });

      if (!ok) {
        await notesCorrectionTokenStore.delete(input.token);
        if (
          !config.mock.enabled &&
          history.notesChannelId &&
          newMessageIds?.length
        ) {
          await deleteDiscordMessagesSafely({
            channelId: history.notesChannelId,
            messageIds: newMessageIds,
          });
        }
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Could not apply this correction because the notes were updated elsewhere. Please regenerate the correction and try again.",
        });
      }

      didPersistNewNotes = true;

      if (
        !config.mock.enabled &&
        history.notesChannelId &&
        history.notesMessageIds?.length
      ) {
        await deleteDiscordMessagesSafely({
          channelId: history.notesChannelId,
          messageIds: history.notesMessageIds,
          skipMessageId: history.summaryMessageId,
        });
      }

      if (
        !config.mock.enabled &&
        history.notesChannelId &&
        history.summaryMessageId
      ) {
        try {
          const message = await fetchDiscordMessage(
            history.notesChannelId,
            history.summaryMessageId,
          );
          const embed = message?.embeds?.[0];
          if (embed) {
            const updated = {
              ...embed,
              title: resolveSummaryTitle({
                meetingName: history.meetingName,
                summaryLabel,
              }),
              description: resolveSummaryDescription({
                summarySentence,
                summaryLabel,
              }),
            };
            await updateDiscordMessageEmbeds(
              history.notesChannelId,
              history.summaryMessageId,
              [updated],
            );
          }
        } catch (error) {
          console.warn(
            "Failed to update summary message after web correction",
            error,
          );
        }
      }

      await notesCorrectionTokenStore.delete(input.token);
      return { ok: true };
    } catch (error) {
      if (
        !didPersistNewNotes &&
        !config.mock.enabled &&
        history.notesChannelId &&
        newMessageIds?.length
      ) {
        await deleteDiscordMessagesSafely({
          channelId: history.notesChannelId,
          messageIds: newMessageIds,
        });
      }
      throw error;
    }
  });

export const meetingsRouter = router({
  list,
  detail,
  setArchived,
  rename,
  suggestNotesCorrection,
  applyNotesCorrection,
});
