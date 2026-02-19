import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  Message,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { formatHunkDiff } from "../utils/diff";
import { v4 as uuidv4 } from "uuid";
import {
  getMeetingHistoryService,
  updateMeetingNotesService,
} from "../services/meetingHistoryService";
import { stripCodeFences } from "../utils/text";
import { MeetingHistory, SuggestionHistoryEntry } from "../types/db";
import { fetchJsonFromS3 } from "../services/storageService";
import { formatParticipantLabel } from "../utils/participants";
import { generateMeetingSummaries } from "../services/meetingSummaryService";
import { formatNotesWithSummary } from "../utils/notesSummary";
import {
  isMeetingNameAutoSynced,
  resolveMeetingNameFromSummary,
} from "../services/meetingNameService";
import { buildMeetingNotesEmbeds } from "../utils/meetingNotes";
import { MEETING_RENAME_PREFIX } from "./meetingName";
import { createOpenAIClient } from "../services/openaiClient";
import { buildModelOverrides, getModelChoice } from "../services/modelFactory";
import { config } from "../services/configService";
import { getLangfuseChatPrompt } from "../services/langfusePromptService";
import { buildSummaryFeedbackButtonIds } from "./summaryFeedback";
import {
  resolveChatParamsForRole,
  resolveModelParamsForContext,
} from "../services/openaiModelParams";
import { resolveModelChoicesForContext } from "../services/modelChoiceService";
import type { ModelParamConfig } from "../config/types";

type PendingCorrection = {
  guildId: string;
  channelIdTimestamp: string;
  meetingId?: string;
  channelId?: string;
  notesMessageIds?: string[];
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
  notesBody: string;
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
const TAG_HISTORY_PREFIX = "edit_tags_history";

function encodeKey(channelIdTimestamp: string): string {
  return Buffer.from(channelIdTimestamp).toString("base64");
}

function decodeKey(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8");
}

function buildCorrectionRow(
  guildId: string,
  channelIdTimestamp: string,
): ActionRowBuilder<ButtonBuilder> {
  const encodedKey = encodeKey(channelIdTimestamp);
  const feedbackIds = buildSummaryFeedbackButtonIds(channelIdTimestamp);
  const feedbackUpButton = new ButtonBuilder()
    .setCustomId(feedbackIds.up)
    .setLabel("Helpful")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("\u{1F44D}");
  const feedbackDownButton = new ButtonBuilder()
    .setCustomId(feedbackIds.down)
    .setLabel("Needs work")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("\u{1F914}");
  const correctionButton = new ButtonBuilder()
    .setCustomId(`${CORRECTION_PREFIX}:${guildId}:${encodedKey}`)
    .setLabel("Suggest correction")
    .setStyle(ButtonStyle.Secondary);
  const renameButton = new ButtonBuilder()
    .setCustomId(`${MEETING_RENAME_PREFIX}:${guildId}:${encodedKey}`)
    .setLabel("Rename meeting")
    .setStyle(ButtonStyle.Secondary);
  const editTagsButton = new ButtonBuilder()
    .setCustomId(`${TAG_HISTORY_PREFIX}:${guildId}:${encodedKey}`)
    .setLabel("Edit Tags")
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    feedbackUpButton,
    feedbackDownButton,
    correctionButton,
    renameButton,
    editTagsButton,
  );
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
  currentNotes: string;
  transcript: string;
  suggestion: string;
  requesterTag: string;
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
  previousSuggestions,
  modelParams,
  modelOverride,
}: CorrectionInput): Promise<string> {
  const priorSuggestions = formatSuggestionsForPrompt(previousSuggestions);
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesCorrectionPromptName,
    variables: {
      currentNotes,
      priorSuggestions,
      transcript,
      requesterTag,
      suggestion,
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
    const openAIClient = createOpenAIClient({
      traceName: "notes-correction",
      generationName: "notes-correction",
      tags: ["feature:notes_correction"],
      metadata: {
        requesterTag,
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
  } catch (error) {
    console.error("Failed to generate corrected notes:", error);
  }

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
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 3) {
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

  await interaction.showModal(modal);
}

export function isNotesCorrectionModal(customId: string): boolean {
  return customId.startsWith(`${CORRECTION_MODAL_PREFIX}:`);
}

export async function handleNotesCorrectionModal(
  interaction: ModalSubmitInteraction,
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 2) {
    await interaction.reply({
      content: "Couldn't process that correction request.",
      ephemeral: true,
    });
    return;
  }

  const encodedKey = parts[1];
  const channelIdTimestamp = decodeKey(encodedKey);
  const guildId = interaction.guildId!;

  await interaction.deferReply({ ephemeral: true });

  try {
    const history = await getMeetingHistoryService(guildId, channelIdTimestamp);

    if (!history || !history.notes) {
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

    const suggestionEntry: SuggestionHistoryEntry = {
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      displayName: memberDisplayName,
      text: suggestion,
      createdAt: new Date().toISOString(),
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

    const newNotes = await generateCorrectedNotes({
      currentNotes: history.notes,
      transcript,
      suggestion,
      requesterTag: interaction.user.tag,
      previousSuggestions: history.suggestionsHistory,
      modelParams: modelParams.notesCorrection,
      modelOverride: modelChoices.notesCorrection,
    });

    const diff = buildCompactDiff(history.notes, newNotes);
    const token = uuidv4();

    pendingCorrections.set(token, {
      guildId,
      channelIdTimestamp,
      meetingId: history.meetingId,
      channelId: history.channelId,
      notesMessageIds: history.notesMessageIds,
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
      notesVersion: history.notesVersion ?? 1,
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

    await interaction.editReply({
      content: `Proposed changes:\n\`\`\`diff\n${diff}\n\`\`\`\nOnly the meeting starter${
        history.isAutoRecording ? " or a server context manager" : ""
      } can accept.`,
      components: [row],
    });
  } catch (error) {
    console.error("Failed to handle notes correction modal:", error);
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
): Promise<{ ok: boolean; errorMessage?: string }> {
  const newVersion = (pending.notesVersion ?? 1) + 1;
  const row = buildCorrectionRow(pending.guildId, pending.channelIdTimestamp);
  const { notesBody, summaries } = await buildCorrectionSummaries(
    interaction,
    pending,
  );
  const { messageIds, channel, strategy } =
    await updateNotesEmbedsForCorrection(
      interaction,
      pending,
      row,
      notesBody,
      newVersion,
      summaries.meetingName,
    );
  const updateSucceeded = await persistCorrectionUpdate({
    pending,
    newVersion,
    editedBy: interaction.user.id,
    summaries,
    newMessageIds: messageIds,
  });

  if (!updateSucceeded) {
    return {
      ok: false,
      errorMessage:
        "Could not apply this correction because the notes were updated elsewhere. Please reopen the correction request and try again.",
    };
  }

  await updateSummaryMessageForCorrection(interaction, pending, summaries);

  if (strategy === "replaced") {
    await cleanupOldNotesMessages(
      channel,
      pending.notesMessageIds,
      messageIds,
      pending.summaryMessageId,
    );
  }

  return { ok: true };
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
  const notesBody = formatNotesWithSummary(pending.newNotes, summarySentence);
  return {
    notesBody,
    summaries: { summarySentence, summaryLabel, meetingName },
  };
}

const SUMMARY_DEFAULT_TITLE = "Meeting Summary";
const SUMMARY_EMPTY_DESCRIPTION = "Summary unavailable.";

function resolveSummaryTitle(
  meetingName?: string,
  summaryLabel?: string,
): string {
  const name = meetingName?.trim();
  if (name) return name;
  const label = summaryLabel?.trim();
  if (label) return label;
  return SUMMARY_DEFAULT_TITLE;
}

function resolveSummaryDescription(
  summarySentence?: string,
  summaryLabel?: string,
): string {
  const summary = summarySentence?.trim() ?? summaryLabel?.trim();
  if (summary && summary.length > 0) return summary;
  return SUMMARY_EMPTY_DESCRIPTION;
}

function isSummaryMessage(message: Message<boolean>): boolean {
  const embed = message.embeds[0];
  if (!embed?.fields?.length) return false;
  const names = new Set(embed.fields.map((field) => field.name.toLowerCase()));
  let matches = 0;
  for (const name of ["start time", "end time", "duration"]) {
    if (names.has(name)) {
      matches += 1;
    }
  }
  return matches >= 2;
}

type NotesEmbedUpdateStrategy = "edited" | "replaced" | "none";

type NotesEmbedUpdateResult = {
  messageIds?: string[];
  channel: Awaited<ReturnType<typeof interactionChannelFetch>> | null;
  strategy: NotesEmbedUpdateStrategy;
};

async function updateNotesEmbedsForCorrection(
  interaction: ButtonInteraction,
  pending: PendingCorrection,
  row: ActionRowBuilder<ButtonBuilder>,
  notesBody: string,
  newVersion: number,
  meetingName?: string,
): Promise<NotesEmbedUpdateResult> {
  if (!pending.notesChannelId) {
    return { channel: null, strategy: "none" };
  }
  const channel = await interactionChannelFetch(
    pending.notesChannelId,
    interaction,
  );
  const existingIds = pending.notesMessageIds ?? [];
  const color = await resolveEmbedColor(channel, existingIds[0]);
  const embeds = buildUpdatedEmbeds(
    notesBody,
    newVersion,
    interaction.user.tag,
    color,
    meetingName,
  );

  if (existingIds.length > 0 && embeds.length <= existingIds.length) {
    const editedIds = await editExistingNotesEmbeds(
      channel,
      existingIds,
      embeds,
      row,
      pending.summaryMessageId,
    );
    if (editedIds) {
      return { messageIds: editedIds, channel, strategy: "edited" };
    }
  }

  const messageIds = await sendNewNotesEmbeds(channel, embeds, row);
  return { messageIds, channel, strategy: "replaced" };
}

async function persistCorrectionUpdate(params: {
  pending: PendingCorrection;
  newVersion: number;
  editedBy: string;
  summaries: {
    summarySentence?: string;
    summaryLabel?: string;
    meetingName?: string;
  };
  newMessageIds?: string[];
}): Promise<boolean> {
  const { pending, newVersion, editedBy, summaries, newMessageIds } = params;
  return updateMeetingNotesService({
    guildId: pending.guildId,
    channelId_timestamp: pending.channelIdTimestamp,
    notes: pending.newNotes,
    notesDelta: null,
    notesVersion: newVersion,
    editedBy,
    summarySentence: summaries.summarySentence,
    summaryLabel: summaries.summaryLabel,
    meetingName: summaries.meetingName,
    suggestion: pending.suggestion,
    expectedPreviousVersion: pending.notesVersion,
    metadata: {
      notesMessageIds: newMessageIds,
      notesChannelId: pending.notesChannelId,
    },
  });
}

async function cleanupOldNotesMessages(
  channel: Awaited<ReturnType<typeof interactionChannelFetch>> | null,
  existingIds?: string[],
  newMessageIds?: string[],
  summaryMessageId?: string,
): Promise<void> {
  if (!channel || !existingIds?.length || !newMessageIds?.length) {
    return;
  }
  try {
    await deleteOldNotesMessages(channel, existingIds, summaryMessageId);
  } catch (error) {
    console.error("Failed to clean up old notes messages after update:", error);
  }
}

async function getPendingOrNotify(
  interaction: ButtonInteraction,
  token: string,
): Promise<PendingCorrection | undefined> {
  const pending = pendingCorrections.get(token);

  if (!pending) {
    await interaction.reply({
      content: "This correction request has expired.",
      ephemeral: true,
    });
    return undefined;
  }

  return pending;
}

function buildUpdatedEmbeds(
  newNotes: string,
  version: number,
  editedByTag?: string,
  color?: number | null,
  meetingName?: string,
) {
  const footerText = editedByTag
    ? `v${version} • Edited by ${editedByTag}`
    : `v${version}`;

  return buildMeetingNotesEmbeds({
    notesBody: newNotes,
    meetingName,
    footerText,
    color: color ?? undefined,
  });
}

async function resolveEmbedColor(
  channel: Awaited<ReturnType<typeof interactionChannelFetch>>,
  messageId?: string,
): Promise<number | undefined> {
  if (!messageId || !channel?.isSendable()) return undefined;
  try {
    const first = await channel.messages.fetch(messageId);
    return first.embeds[0]?.color ?? undefined;
  } catch (error) {
    console.error("Failed to fetch existing notes message for color:", error);
    return undefined;
  }
}

async function interactionChannelFetch(
  channelId: string,
  interaction: ButtonInteraction,
) {
  return interaction.client.channels.fetch(channelId);
}

async function editExistingNotesEmbeds(
  channel: Awaited<ReturnType<typeof interactionChannelFetch>>,
  existingIds: string[],
  embeds: ReturnType<typeof buildUpdatedEmbeds>,
  row: ActionRowBuilder<ButtonBuilder>,
  summaryMessageId?: string,
): Promise<string[] | null> {
  if (!channel?.isSendable()) return null;

  const editedIds: string[] = [];
  for (let i = 0; i < embeds.length; i++) {
    const messageId = existingIds[i];
    if (summaryMessageId && messageId === summaryMessageId) {
      return null;
    }
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({
        embeds: [embeds[i]],
        components: i === 0 ? [row] : [],
      });
      editedIds.push(messageId);
    } catch {
      console.warn(
        "Failed to edit notes message in-place, falling back to replace",
      );
      return null;
    }
  }

  for (let i = embeds.length; i < existingIds.length; i++) {
    const messageId = existingIds[i];
    if (summaryMessageId && messageId === summaryMessageId) continue;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    } catch {
      console.warn("Failed to delete excess notes message after in-place edit");
    }
  }

  return editedIds;
}

async function sendNewNotesEmbeds(
  channel: Awaited<ReturnType<typeof interactionChannelFetch>>,
  embeds: ReturnType<typeof buildUpdatedEmbeds>,
  row: ActionRowBuilder<ButtonBuilder>,
): Promise<string[] | undefined> {
  if (!channel?.isSendable()) return undefined;
  const sentIds: string[] = [];
  for (let i = 0; i < embeds.length; i++) {
    const msg = await channel.send({
      embeds: [embeds[i]],
      components: i === 0 ? [row] : [],
    });
    sentIds.push(msg.id);
  }
  return sentIds;
}

async function deleteOldNotesMessages(
  channel: Awaited<ReturnType<typeof interactionChannelFetch>>,
  messageIds: string[],
  summaryMessageId?: string,
): Promise<void> {
  if (!channel?.isSendable()) return;
  for (const id of messageIds) {
    try {
      if (summaryMessageId && id === summaryMessageId) {
        continue;
      }
      const msg = await channel.messages.fetch(id);
      if (!summaryMessageId && isSummaryMessage(msg)) {
        continue;
      }
      await msg.delete();
    } catch (error) {
      console.error("Failed to delete old notes message after update:", error);
    }
  }
}

async function updateSummaryMessageForCorrection(
  interaction: ButtonInteraction,
  pending: PendingCorrection,
  summaries: {
    summarySentence?: string;
    summaryLabel?: string;
    meetingName?: string;
  },
): Promise<void> {
  if (!pending.notesChannelId) return;
  const channel = await interactionChannelFetch(
    pending.notesChannelId,
    interaction,
  );
  if (!channel?.isSendable()) return;

  let summaryMessage: Message<boolean> | null = null;
  if (pending.summaryMessageId) {
    try {
      summaryMessage = await channel.messages.fetch(pending.summaryMessageId);
    } catch (error) {
      console.warn(
        "Failed to fetch summary message for correction update",
        error,
      );
    }
  }

  if (!summaryMessage && pending.notesMessageIds?.length) {
    for (const id of pending.notesMessageIds) {
      try {
        const candidate = await channel.messages.fetch(id);
        if (isSummaryMessage(candidate)) {
          summaryMessage = candidate;
          break;
        }
      } catch (error) {
        console.warn("Failed to scan notes messages for summary update", error);
      }
    }
  }

  if (!summaryMessage) return;
  const existingEmbed = summaryMessage.embeds[0];
  if (!existingEmbed) return;
  const updated = EmbedBuilder.from(existingEmbed)
    .setTitle(
      resolveSummaryTitle(summaries.meetingName, summaries.summaryLabel),
    )
    .setDescription(
      resolveSummaryDescription(
        summaries.summarySentence,
        summaries.summaryLabel,
      ),
    );
  try {
    await summaryMessage.edit({ embeds: [updated] });
  } catch (error) {
    console.warn("Failed to update summary message after correction", error);
  }
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
) {
  const [, token] = interaction.customId.split(":");
  const pending = await getPendingOrNotify(interaction, token);
  if (!pending) return;

  if (!canApprove(interaction, pending)) {
    await interaction.reply({
      content:
        "Only the meeting starter (or a context manager for auto-started meetings) can accept corrections.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  await interaction.editReply({
    content: "Applying correction...",
    components: [],
  });

  try {
    const result = await applyCorrection(interaction, pending);
    if (!result.ok) {
      await interaction.editReply({
        content:
          result.errorMessage ??
          "Unable to apply this correction right now. Please try again.",
        components: [],
      });
      return;
    }

    pendingCorrections.delete(token);
    await interaction.editReply({
      content: "Correction applied and notes updated.",
      components: [],
    });
  } catch (error) {
    console.error("Failed applying notes correction:", error);
    await interaction.editReply({
      content: "Failed to apply correction. Please try again.",
      components: [],
    });
  }
}

export async function handleNotesCorrectionReject(
  interaction: ButtonInteraction,
) {
  const [, token] = interaction.customId.split(":");
  const pending = await getPendingOrNotify(interaction, token);
  if (!pending) return;

  const canReject =
    interaction.user.id === pending.requesterId ||
    canApprove(interaction, pending);

  if (!canReject) {
    await interaction.reply({
      content:
        "You don't have permission to reject this correction. Ask the meeting starter or a context manager (auto-record) to handle it.",
      ephemeral: true,
    });
    return;
  }

  pendingCorrections.delete(token);
  await interaction.update({
    content: "Correction rejected.",
    components: [],
  });
}
