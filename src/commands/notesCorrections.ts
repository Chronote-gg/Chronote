import { updateMeeting } from "../services/meetingUpdateService";
import { approvedCorrectionMutation } from "../services/approvedMeetingCorrection";
import { UnresolvedNotionMutation } from "../services/notionOperationLifetime";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { formatHunkDiff } from "../utils/diff";
import { v4 as uuidv4 } from "uuid";
import { getMeetingHistoryService } from "../services/meetingHistoryService";
import { stripCodeFences } from "../utils/text";
import {
  collectMentionIds,
  mergeAllowedMentions,
  stripUnknownMentions,
} from "../utils/mentionSanitizer";
import { buildMentionRosters } from "../services/mentionRosterService";
import { MeetingHistory, SuggestionHistoryEntry } from "../types/db";
import { fetchJsonFromS3 } from "../services/storageService";
import { formatParticipantLabel } from "../utils/participants";
import { generateMeetingSummaries } from "../services/meetingSummaryService";

import {
  isMeetingNameAutoSynced,
  resolveMeetingNameFromSummary,
} from "../services/meetingNameService";

import { type CaptureNoticeInput } from "../utils/meetingCaptureNotice";

import { generateOpenAIText } from "../services/openaiTextService";
import { buildModelOverrides, getModelChoice } from "../services/modelFactory";
import { config } from "../services/configService";
import { getLangfuseChatPrompt } from "../services/langfusePromptService";

import {
  resolveChatParamsForRole,
  resolveModelParamsForContext,
} from "../services/openaiModelParams";
import { resolveModelChoicesForContext } from "../services/modelChoiceService";
import type { ModelParamConfig } from "../config/types";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";

type PendingCorrection = {
  guildId: string;
  channelIdTimestamp: string;
  meetingId?: string;
  channelId?: string;
  notesMessageIds?: string[];
  processing?: MeetingProcessingOutcome;
  captureNoticeInput?: CaptureNoticeInput;
  notesChannelId?: string;
  summaryMessageId?: string;
  meetingCreatorId?: string;
  isAutoRecording?: boolean;
  tags?: string[];
  meetingName?: string;
  summarySentence?: string;
  summaryLabel?: string;
  originalNotes: string;
  newNotes: string;
  notesVersion: number;
  requesterId: string;
  suggestion: SuggestionHistoryEntry;
};

type CorrectionSummariesResult = {
  summaries: {
    summarySentence?: string;
    summaryLabel?: string;
    meetingName?: string;
  };
};

const pendingCorrections = new Map<string, PendingCorrection>();

const CORRECTION_PREFIX = "notes_correction";
const CORRECTION_MODAL_PREFIX = "notes_correction_modal";
const CORRECTION_ACCEPT_PREFIX = "notes_correction_accept";
const CORRECTION_REJECT_PREFIX = "notes_correction_reject";

function decodeKey(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** Discord message content is capped at 2000 chars; reserve room for wrapper text. */
const DISCORD_DIFF_CHAR_LIMIT = 1800;
const DISCORD_DIFF_LINE_LIMIT = 400;

function buildCompactDiff(current: string, proposed: string): string {
  return formatHunkDiff(current, proposed, {
    charLimit: DISCORD_DIFF_CHAR_LIMIT,
    lineLimit: DISCORD_DIFF_LINE_LIMIT,
  });
}

interface CorrectionInput {
  signal?: AbortSignal;
  currentNotes: string;
  transcript: string;
  suggestion: string;
  requesterTag: string;
  /** Supplies the rosters, so a correction can add a mention rather than a bare name. */
  meeting: Pick<MeetingHistory, "guildId" | "ownershipScope" | "participants">;
  previousSuggestions?: SuggestionHistoryEntry[];
  modelParams?: ModelParamConfig;
  modelOverride?: string;
}

function formatSuggestionsForPrompt(
  suggestions?: SuggestionHistoryEntry[],
): string {
  if (!suggestions || suggestions.length === 0) {
    return "None recorded yet.";
  }

  return suggestions
    .map(
      (entry) =>
        `- [${new Date(entry.createdAt).toLocaleString()}] ${entry.displayName || entry.userTag || entry.userId}: ${entry.text}`,
    )
    .join("\n");
}

async function generateCorrectedNotes({
  currentNotes,
  transcript,
  suggestion,
  requesterTag,
  meeting,
  previousSuggestions,
  modelParams,
  modelOverride,
  signal,
}: CorrectionInput): Promise<string> {
  const priorSuggestions = formatSuggestionsForPrompt(previousSuggestions);
  const rosters = await buildMentionRosters(meeting);
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesCorrectionPromptName,
    variables: {
      currentNotes,
      priorSuggestions,
      transcript,
      requesterTag,
      suggestion,
      participantRoster: rosters.participantRoster,
      roles: rosters.roles,
    },
  });

  try {
    const modelChoice = getModelChoice(
      "notesCorrection",
      buildModelOverrides(
        modelOverride ? { notesCorrection: modelOverride } : undefined,
      ),
    );
    const chatParams = resolveChatParamsForRole({
      role: "notesCorrection",
      model: modelChoice.model,
      config: modelParams,
    });
    signal?.throwIfAborted();
    const content = await generateOpenAIText({
      model: modelChoice.model,
      input: messages,
      modelParams: chatParams,
      signal,
      tracing: {
        traceName: "notes-correction",
        generationName: "notes-correction",
        tags: ["feature:notes_correction"],
        metadata: { requesterTag },
        langfusePrompt,
      },
    });
    signal?.throwIfAborted();

    if (content && content.trim().length > 0) {
      // A correction may keep the mentions already in the notes and may add one
      // the rosters offered, but anything outside both was invented.
      return stripUnknownMentions(
        stripCodeFences(content.trim()),
        mergeAllowedMentions(collectMentionIds(currentNotes), {
          userIds: rosters.allowedUserIds,
          roleIds: rosters.allowedRoleIds,
        }),
      );
    }
  } catch (error) {
    signal?.throwIfAborted();
    console.error("Failed to generate corrected notes:", error);
  }

  signal?.throwIfAborted();
  // Fallback: return original notes unchanged if AI call failed
  return currentNotes;
}

function canApprove(
  interaction: ButtonInteraction,
  pending: PendingCorrection,
): boolean {
  if (!pending.isAutoRecording) {
    return interaction.user.id === pending.meetingCreatorId;
  }

  // Auto-recorded: require ManageChannels (same as context command)
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageChannels);
}

export function isNotesCorrectionButton(customId: string): boolean {
  return customId.startsWith(`${CORRECTION_PREFIX}:`);
}

export function isNotesCorrectionAccept(customId: string): boolean {
  return customId.startsWith(`${CORRECTION_ACCEPT_PREFIX}:`);
}

export function isNotesCorrectionReject(customId: string): boolean {
  return customId.startsWith(`${CORRECTION_REJECT_PREFIX}:`);
}

export async function handleNotesCorrectionButton(
  interaction: ButtonInteraction,
  signal?: AbortSignal,
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 3) {
    signal?.throwIfAborted();
    await interaction.reply({
      content: "Sorry, I couldn't start the correction flow (invalid id).",
      ephemeral: true,
    });
    return;
  }

  const encodedKey = parts[2];
  // Keep customId under Discord's 100-char limit by omitting guildId (it's available on interaction)
  const modal = new ModalBuilder()
    .setCustomId(`${CORRECTION_MODAL_PREFIX}:${encodedKey}`)
    .setTitle("Suggest a correction");

  const suggestionInput = new TextInputBuilder()
    .setCustomId("correction_suggestion")
    .setLabel("Describe what should change in the notes")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  const suggestionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
    suggestionInput,
  );

  modal.addComponents(suggestionRow);

  signal?.throwIfAborted();
  await interaction.showModal(modal);
}

export function isNotesCorrectionModal(customId: string): boolean {
  return customId.startsWith(`${CORRECTION_MODAL_PREFIX}:`);
}

export async function handleNotesCorrectionModal(
  interaction: ModalSubmitInteraction,
  signal?: AbortSignal,
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 2) {
    signal?.throwIfAborted();
    await interaction.reply({
      content: "Couldn't process that correction request.",
      ephemeral: true,
    });
    return;
  }

  const encodedKey = parts[1];
  const channelIdTimestamp = decodeKey(encodedKey);
  const guildId = interaction.guildId!;

  signal?.throwIfAborted();
  await interaction.deferReply({ ephemeral: true });

  try {
    const history = await getMeetingHistoryService(guildId, channelIdTimestamp);

    if (!history || !history.notes) {
      signal?.throwIfAborted();
      await interaction.editReply({
        content:
          "I couldn't find notes to compare against yet. Please try again once the meeting has finished processing.",
      });
      return;
    }

    const suggestion = interaction.fields.getTextInputValue(
      "correction_suggestion",
    );

    const memberDisplayName =
      ("member" in interaction &&
        interaction.member &&
        (interaction.member as GuildMember).displayName) ||
      interaction.user.globalName ||
      interaction.user.username;

    const correctionId = uuidv4();
    const baseNotesVersion = history.notesVersion ?? 1;
    const suggestionEntry: SuggestionHistoryEntry = {
      correctionId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      displayName: memberDisplayName,
      text: suggestion,
      createdAt: new Date().toISOString(),
      source: "discord",
      baseNotesVersion,
    };

    const transcript = await resolveTranscript(history);
    const modelParams = await resolveModelParamsForContext({
      guildId,
      channelId: history.channelId ?? channelIdTimestamp.split("#")[0],
      userId: interaction.user.id,
    });
    const modelChoices = await resolveModelChoicesForContext({
      guildId,
      channelId: history.channelId ?? channelIdTimestamp.split("#")[0],
      userId: interaction.user.id,
    });

    signal?.throwIfAborted();
    const newNotes = await generateCorrectedNotes({
      currentNotes: history.notes,
      transcript,
      suggestion,
      requesterTag: interaction.user.tag,
      meeting: history,
      previousSuggestions: history.suggestionsHistory,
      modelParams: modelParams.notesCorrection,
      modelOverride: modelChoices.notesCorrection,
      signal,
    });

    const diff = buildCompactDiff(history.notes, newNotes);
    const token = uuidv4();

    signal?.throwIfAborted();
    pendingCorrections.set(token, {
      guildId,
      channelIdTimestamp,
      meetingId: history.meetingId,
      channelId: history.channelId,
      notesMessageIds: history.notesMessageIds,
      processing: history.processing,
      captureNoticeInput: {
        capture: history.capture,
        captureCoverage: history.captureCoverage,
        status: history.status,
        processing: history.processing,
        notes: history.notes,
      },
      notesChannelId: history.notesChannelId,
      summaryMessageId: history.summaryMessageId,
      meetingCreatorId: history.meetingCreatorId,
      isAutoRecording: history.isAutoRecording,
      tags: history.tags,
      meetingName: history.meetingName,
      summarySentence: history.summarySentence,
      summaryLabel: history.summaryLabel,
      originalNotes: history.notes,
      newNotes,
      notesVersion: baseNotesVersion,
      requesterId: interaction.user.id,
      suggestion: suggestionEntry,
    });

    const accept = new ButtonBuilder()
      .setCustomId(`${CORRECTION_ACCEPT_PREFIX}:${token}`)
      .setLabel("Accept & update")
      .setStyle(ButtonStyle.Success);

    const reject = new ButtonBuilder()
      .setCustomId(`${CORRECTION_REJECT_PREFIX}:${token}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      accept,
      reject,
    );

    signal?.throwIfAborted();
    await interaction.editReply({
      content: `Proposed changes:\n\`\`\`diff\n${diff}\n\`\`\`\nOnly the meeting starter${
        history.isAutoRecording ? " or a server context manager" : ""
      } can accept.`,
      components: [row],
      // The diff quotes notes that can contain mentions. The code fence
      // already suppresses them, this makes it explicit rather than relying
      // on that rendering detail.
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof UnresolvedNotionMutation) throw error;
    if (signal?.aborted) return;
    console.error("Failed to handle notes correction modal:", error);
    signal?.throwIfAborted();
    await interaction.editReply({
      content:
        "Something went wrong while generating the proposed correction. Please try again.",
      components: [],
    });
  }
}

async function applyCorrection(
  interaction: ButtonInteraction,
  pending: PendingCorrection,
  signal?: AbortSignal,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const newVersion = pending.notesVersion + 1;
  const { summaries } = await buildCorrectionSummaries(
    interaction,
    pending,
    signal,
  );
  signal?.throwIfAborted();
  const correctionId = pending.suggestion.correctionId ?? uuidv4();
  const saved = await updateMeeting({
    key: {
      guildId: pending.guildId,
      channelId_timestamp: pending.channelIdTimestamp,
    },
    mutation: approvedCorrectionMutation({
      history: pending,
      notes: pending.newNotes,
      ...summaries,
    }),
    actor: { editedBy: interaction.user.id },
    notesEdit: {
      expectedNotesVersion: pending.notesVersion,
      source: { type: "notes_correction", correctionId },
      suggestion: {
        ...pending.suggestion,
        correctionId,
        source: "discord",
        baseNotesVersion: pending.notesVersion,
        resultingNotesVersion: newVersion,
      },
    },
    signal,
  });
  return saved.kind === "saved"
    ? { ok: true }
    : {
        ok: false,
        errorMessage:
          "Could not apply this correction because the notes were updated elsewhere. Please reopen the correction request and try again.",
      };
}

function resolveChannelName(
  interaction: ButtonInteraction,
  channelId: string,
): string {
  const guild = interaction.guild;
  if (!guild) {
    return channelId;
  }
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    return channelId;
  }
  return channel.name || channelId;
}

async function buildCorrectionSummaries(
  interaction: ButtonInteraction,
  pending: PendingCorrection,
  signal?: AbortSignal,
): Promise<CorrectionSummariesResult> {
  const serverName = interaction.guild?.name ?? "Unknown server";
  const channelName = resolveChannelName(
    interaction,
    pending.channelId ?? pending.channelIdTimestamp.split("#")[0],
  );
  const modelParams = await resolveModelParamsForContext({
    guildId: pending.guildId,
    channelId: pending.channelId ?? pending.channelIdTimestamp.split("#")[0],
    userId: interaction.user.id,
  });
  const modelChoices = await resolveModelChoicesForContext({
    guildId: pending.guildId,
    channelId: pending.channelId ?? pending.channelIdTimestamp.split("#")[0],
    userId: interaction.user.id,
  });
  const [, timestamp] = pending.channelIdTimestamp.split("#");
  const meetingDate = timestamp ? new Date(timestamp) : new Date();
  signal?.throwIfAborted();
  const summaries = await generateMeetingSummaries({
    guildId: pending.guildId,
    notes: pending.newNotes,
    serverName,
    channelName,
    tags: pending.tags,
    now: meetingDate,
    meetingId: pending.meetingId,
    previousSummarySentence: pending.summarySentence,
    previousSummaryLabel: pending.summaryLabel,
    modelParams: modelParams.meetingSummary,
    modelOverride: modelChoices.meetingSummary,
    signal,
  });
  const summarySentence = summaries.summarySentence ?? pending.summarySentence;
  const summaryLabel = summaries.summaryLabel ?? pending.summaryLabel;
  const shouldUpdateMeetingName = isMeetingNameAutoSynced(
    pending.meetingName,
    pending.summaryLabel,
  );
  const resolvedMeetingName = shouldUpdateMeetingName
    ? await resolveMeetingNameFromSummary({
        guildId: pending.guildId,
        meetingId: pending.meetingId,
        summaryLabel,
      })
    : pending.meetingName;
  const meetingName = resolvedMeetingName ?? pending.meetingName;
  if (
    !summaries.summarySentence &&
    !summaries.summaryLabel &&
    (pending.summarySentence || pending.summaryLabel)
  ) {
    console.warn(
      "Meeting summary generation returned empty, keeping previous summaries.",
    );
  }
  return {
    summaries: { summarySentence, summaryLabel, meetingName },
  };
}

async function getPendingOrNotify(
  interaction: ButtonInteraction,
  token: string,
  signal?: AbortSignal,
): Promise<PendingCorrection | undefined> {
  const pending = pendingCorrections.get(token);

  if (!pending) {
    signal?.throwIfAborted();
    await interaction.reply({
      content: "This correction request has expired.",
      ephemeral: true,
    });
    return undefined;
  }

  return pending;
}

async function resolveTranscript(history: MeetingHistory): Promise<string> {
  if (history.transcriptS3Key) {
    const payload = await fetchJsonFromS3<{
      text?: string;
      segments?: Array<{
        userId?: string;
        text?: string;
        username?: string;
        displayName?: string;
        serverNickname?: string;
        tag?: string;
      }>;
    }>(history.transcriptS3Key);
    if (payload?.text) {
      return payload.text;
    }
    if (payload?.segments?.length) {
      return payload.segments
        .filter((segment) => segment.text)
        .map((segment) => {
          const speaker = formatParticipantLabel(
            {
              id: segment.userId ?? "unknown",
              username: segment.username ?? segment.tag ?? "unknown",
              displayName: segment.displayName,
              serverNickname: segment.serverNickname,
              tag: segment.tag,
            },
            {
              includeUsername: true,
              fallbackName:
                segment.serverNickname ||
                segment.displayName ||
                segment.username ||
                segment.tag ||
                "Unknown",
              fallbackUsername: segment.username ?? segment.tag,
            },
          );
          return `${speaker}: ${segment.text}`;
        })
        .join("\n");
    }
  }

  return "";
}

export async function handleNotesCorrectionAccept(
  interaction: ButtonInteraction,
  signal?: AbortSignal,
) {
  const [, token] = interaction.customId.split(":");
  const pending = await getPendingOrNotify(interaction, token, signal);
  if (!pending) return;

  if (!canApprove(interaction, pending)) {
    signal?.throwIfAborted();
    await interaction.reply({
      content:
        "Only the meeting starter (or a context manager for auto-started meetings) can accept corrections.",
      ephemeral: true,
    });
    return;
  }

  signal?.throwIfAborted();
  await interaction.deferUpdate();
  signal?.throwIfAborted();
  await interaction.editReply({
    content: "Applying correction...",
    components: [],
  });

  try {
    const result = await applyCorrection(interaction, pending, signal);
    if (!result.ok) {
      signal?.throwIfAborted();
      await interaction.editReply({
        content:
          result.errorMessage ??
          "Unable to apply this correction right now. Please try again.",
        components: [],
      });
      return;
    }

    pendingCorrections.delete(token);
    signal?.throwIfAborted();
    await interaction.editReply({
      content: "Correction saved.",
      components: [],
    });
  } catch (error) {
    if (error instanceof UnresolvedNotionMutation) throw error;
    if (signal?.aborted) return;
    console.error("Failed applying notes correction:", error);
    signal?.throwIfAborted();
    await interaction.editReply({
      content: "Failed to apply correction. Please try again.",
      components: [],
    });
  }
}

export async function handleNotesCorrectionReject(
  interaction: ButtonInteraction,
  signal?: AbortSignal,
) {
  const [, token] = interaction.customId.split(":");
  const pending = await getPendingOrNotify(interaction, token, signal);
  if (!pending) return;

  const canReject =
    interaction.user.id === pending.requesterId ||
    canApprove(interaction, pending);

  if (!canReject) {
    signal?.throwIfAborted();
    await interaction.reply({
      content:
        "You don't have permission to reject this correction. Ask the meeting starter or a context manager (auto-record) to handle it.",
      ephemeral: true,
    });
    return;
  }

  pendingCorrections.delete(token);
  signal?.throwIfAborted();
  await interaction.update({
    content: "Correction rejected.",
    components: [],
  });
}
