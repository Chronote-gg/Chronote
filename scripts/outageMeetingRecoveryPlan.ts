import { createHash } from "node:crypto";
import type { APIEmbed } from "discord.js";
import type { MeetingProcessingOutcome } from "../src/types/meetingProcessing";
import type { TranscriptPayload } from "../src/types/transcript";
import {
  batchMeetingNotesEmbeds,
  buildMeetingNotesEmbeds,
} from "../src/utils/meetingNotes";
import { trimNotesForHistory } from "../src/utils/notesHistory";

// Matches SUMMARY_COLOR and the summary fallbacks in embed.ts and
// notesCorrections.ts at production commit 593a6d6.
const LEGACY_SUMMARY_COLOR = 0x00ae86;
const LEGACY_SUMMARY_DEFAULT_TITLE = "Meeting Summary";
const LEGACY_SUMMARY_EMPTY_DESCRIPTION = "Summary unavailable.";
const PROCESSING_FIELDS = ["transcription", "notes", "summary"] as const;

export type ObservedHistory = {
  guildId: string;
  channelId_timestamp: string;
  meetingId: string;
  channelId: string;
  timestamp: string;
  duration: number;
  meetingCreatorId?: string;
  processing?: MeetingProcessingOutcome;
  notesChannelId?: string;
  textChannelId?: string;
  notesMessageIds?: string[];
  summaryMessageId?: string;
  transcriptS3Key?: string;
  meetingName?: string;
  notes?: string;
  notesVersion?: number;
};

export type PlannedTranscript = { key: string; body: string };

export type PlanInput = {
  table: string;
  bucket: string;
  region: string;
  history: ObservedHistory;
  transcription: NonNullable<MeetingProcessingOutcome["transcription"]>;
  notes: string;
  summarySentence?: string;
  summaryLabel?: string;
  meetingName?: string;
  transcript?: PlannedTranscript;
  generation: Record<string, unknown>;
  now: string;
};

export type DiscordNotesPatch = {
  channelId: string;
  messageId: string;
  body: { embeds: APIEmbed[]; allowed_mentions: { parse: [] } };
};

export type PlannedWrite = {
  version: 1;
  createdAt: string;
  region: string;
  generation: Record<string, unknown>;
  meeting: { guildId: string; channelIdTimestamp: string; meetingId: string };
  dynamo: {
    TableName: string;
    Key: { guildId: string; channelId_timestamp: string };
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  s3?: {
    bucket: string;
    key: string;
    contentType: "application/json";
    body: string;
    sha256: string;
  };
  discord: {
    notes: DiscordNotesPatch[];
    summary?: {
      channelId: string;
      messageId: string;
      title: string;
      description: string;
    };
  };
};

export const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

export const serializePlan = (plan: PlannedWrite) =>
  `${JSON.stringify(plan, null, 2)}\n`;

/** Apply reads exactly the bytes the operator approved, or nothing. */
export function parseApprovedPlan(
  fileContent: string,
  expectedSha256: string,
): PlannedWrite {
  const actual = sha256(fileContent);
  if (actual !== expectedSha256.toLowerCase())
    throw new Error(
      `Planned write digest mismatch: expected ${expectedSha256}, file is ${actual}. Re-run the dry run and review the new plan.`,
    );
  const plan: PlannedWrite = JSON.parse(fileContent);
  if (plan.version !== 1) throw new Error("Unsupported planned write version");
  return plan;
}

export function legacyMeetingEndTime(history: ObservedHistory): string {
  return new Date(
    Date.parse(history.timestamp) + history.duration * 1000,
  ).toISOString();
}

/** Shape written by uploadService.buildTranscriptJson at 593a6d6. */
export function buildLegacyTranscriptPayload(input: {
  history: ObservedHistory;
  text: string;
  generatedAt: string;
}): TranscriptPayload & {
  guildId: string;
  channelId: string;
  meetingId: string;
} {
  return {
    generatedAt: input.generatedAt,
    guildId: input.history.guildId,
    channelId: input.history.channelId,
    meetingId: input.history.meetingId,
    // The mixed recording carries no speaker identity, so the one segment is
    // deliberately unattributed rather than credited to any participant.
    segments: [
      {
        userId: "unattributed",
        username: "Unattributed audio",
        displayName: "Unattributed audio",
        startedAt: input.history.timestamp,
        text: input.text,
        source: "voice",
      },
    ],
    text: input.text,
  };
}

export function resolveLegacySummaryText(input: {
  meetingName?: string;
  summarySentence?: string;
  summaryLabel?: string;
}) {
  return {
    title:
      input.meetingName?.trim() ||
      input.summaryLabel?.trim() ||
      LEGACY_SUMMARY_DEFAULT_TITLE,
    description:
      input.summarySentence?.trim() ||
      input.summaryLabel?.trim() ||
      LEGACY_SUMMARY_EMPTY_DESCRIPTION,
  };
}

/** Mirrors the 593a6d6 correction flow: keep the embed, swap title and description. */
export function mergeSummaryEmbeds(
  existing: APIEmbed[],
  update: { title: string; description: string },
): APIEmbed[] {
  const [first, ...rest] = existing;
  if (!first) throw new Error("Summary message has no embed to update");
  return [{ ...first, ...update }, ...rest];
}

export function buildLegacyNotesPatches(input: {
  notes: string;
  processing: MeetingProcessingOutcome;
  channelId: string;
  messageIds: string[];
  timestamp: string;
}): DiscordNotesPatch[] {
  const embeds = buildMeetingNotesEmbeds({
    notesBody: input.notes,
    color: LEGACY_SUMMARY_COLOR,
    processing: input.processing,
  }).map((embed) => embed.setTimestamp(new Date(input.timestamp)));
  const batches = batchMeetingNotesEmbeds(embeds);
  // ponytail: in-place edits only. Notes that outgrow the existing messages
  // would need new posts plus a notesMessageIds update; add that if it happens.
  if (batches.length > input.messageIds.length)
    throw new Error(
      `Notes need ${batches.length} Discord messages but only ${input.messageIds.length} exist`,
    );
  return batches.map((batch, index) => ({
    channelId: input.channelId,
    messageId: input.messageIds[index],
    body: {
      embeds: batch.map((embed) => embed.toJSON()),
      allowed_mentions: { parse: [] },
    },
  }));
}

function observedProcessingCondition(
  processing: MeetingProcessingOutcome | undefined,
  values: Record<string, unknown>,
) {
  return PROCESSING_FIELDS.map((field) => {
    const observed = processing?.[field];
    if (observed === undefined)
      return `attribute_not_exists(#processing.#${field})`;
    values[`:observed_${field}`] = observed;
    return `#processing.#${field} = :observed_${field}`;
  });
}

export function buildPlannedWrite(input: PlanInput): PlannedWrite {
  const { history } = input;
  if (history.notesVersion !== undefined || history.notes)
    throw new Error("Meeting already has notes; refusing to plan a rewrite");
  if (!history.meetingCreatorId)
    throw new Error("Meeting has no meetingCreatorId to attribute notes to");
  if (input.transcript && history.transcriptS3Key)
    throw new Error("Meeting already has a transcript key");
  const editedAt = legacyMeetingEndTime(history);
  const summaryGenerated = Boolean(
    input.summarySentence?.trim() || input.summaryLabel?.trim(),
  );
  const processing: MeetingProcessingOutcome = {
    transcription: input.transcription,
    notes: "generated",
    summary: summaryGenerated ? "generated" : "failed",
  };
  const names: Record<string, string> = {
    "#notes": "notes",
    "#processing": "processing",
    "#notesVersion": "notesVersion",
    "#notesLastEditedBy": "notesLastEditedBy",
    "#notesLastEditedAt": "notesLastEditedAt",
    "#notesHistory": "notesHistory",
    "#updatedAt": "updatedAt",
    ...Object.fromEntries(PROCESSING_FIELDS.map((f) => [`#${f}`, f])),
  };
  const values: Record<string, unknown> = {
    ":notes": input.notes,
    ":processing": processing,
    ":notesVersion": 1,
    ":editedBy": history.meetingCreatorId,
    ":editedAt": editedAt,
    ":notesHistory": [
      {
        version: 1,
        notes: trimNotesForHistory(input.notes),
        editedBy: history.meetingCreatorId,
        editedAt,
      },
    ],
    ":updatedAt": input.now,
  };
  const sets = [
    "#notes = :notes",
    "#processing = :processing",
    "#notesVersion = :notesVersion",
    "#notesLastEditedBy = :editedBy",
    "#notesLastEditedAt = :editedAt",
    "#notesHistory = :notesHistory",
    "#updatedAt = :updatedAt",
  ];
  const conditions = [
    "attribute_not_exists(#notesVersion)",
    "attribute_not_exists(#notes)",
  ];
  const optional: Array<[string, string | undefined]> = [
    ["summarySentence", input.summarySentence],
    ["summaryLabel", input.summaryLabel],
    ["meetingName", input.meetingName],
    ["transcriptS3Key", input.transcript?.key],
  ];
  for (const [field, value] of optional) {
    if (!value) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
    // Never overwrite a name or transcript someone set after the dry run.
    if (field === "meetingName" || field === "transcriptS3Key")
      conditions.push(`attribute_not_exists(#${field})`);
  }
  conditions.push(...observedProcessingCondition(history.processing, values));

  const notesChannelId = history.notesChannelId ?? history.textChannelId;
  const notesMessageIds = history.notesMessageIds ?? [];
  if (!notesChannelId && notesMessageIds.length)
    throw new Error("Notes messages exist without a channel id");
  const summaryText = resolveLegacySummaryText({
    meetingName: input.meetingName ?? history.meetingName,
    summarySentence: input.summarySentence,
    summaryLabel: input.summaryLabel,
  });

  return {
    version: 1,
    createdAt: input.now,
    region: input.region,
    generation: input.generation,
    meeting: {
      guildId: history.guildId,
      channelIdTimestamp: history.channelId_timestamp,
      meetingId: history.meetingId,
    },
    dynamo: {
      TableName: input.table,
      Key: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
    ...(input.transcript
      ? {
          s3: {
            bucket: input.bucket,
            key: input.transcript.key,
            contentType: "application/json" as const,
            body: input.transcript.body,
            sha256: sha256(input.transcript.body),
          },
        }
      : {}),
    discord: {
      notes:
        notesChannelId && notesMessageIds.length
          ? buildLegacyNotesPatches({
              notes: input.notes,
              processing,
              channelId: notesChannelId,
              messageIds: notesMessageIds,
              timestamp: editedAt,
            })
          : [],
      ...(history.summaryMessageId && history.textChannelId
        ? {
            summary: {
              channelId: history.textChannelId,
              messageId: history.summaryMessageId,
              ...summaryText,
            },
          }
        : {}),
    },
  };
}

/** Transcript lives beside the recording, as the legacy uploader names it. */
export function transcriptKeyBesideAudio(audioS3Key: string) {
  const slash = audioS3Key.lastIndexOf("/");
  if (slash < 0) throw new Error("audioS3Key has no folder");
  return `${audioS3Key.slice(0, slash + 1)}transcript.json`;
}
