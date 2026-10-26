import { createHash } from "node:crypto";
import type { PublicationDependencies } from "../../src/services/recoveryDiscordPublication";
import type { DiscordEditorMessage } from "../../src/services/discordMessageEditor";
export const sha = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const timestamp = "2026-01-02T03:04:05.000Z";
export const folder = "private/100/200_meeting-1_2026-01-02T03-04-05.000Z/";
export const recovery = `${folder}recovery/approved-1/`;
export const input = {
  accountId: "123456789012",
  region: "us-east-1",
  table: "History",
  bucket: "private-artifacts",
  guildId: "100",
  meetingKey: `200#${timestamp}`,
  recoveryManifestKey: `${recovery}manifest.json`,
};
export function fixture(notes = "Обсуждение. Имя говорящего не подтверждено.") {
  const history = {
    guildId: "100",
    channelId_timestamp: input.meetingKey,
    channelId: "200",
    timestamp,
    meetingId: "meeting-1",
    notes,
    notesVersion: 2,
    meetingName: "Совещание",
    summarySentence: "Решение остаётся предварительным.",
    summaryLabel: "Итоги",
    transcriptS3Key: `${recovery}transcript.json`,
    notesChannelId: "300",
    notesMessageIds: ["400"],
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
    operatorRecovery: {
      appliedAt: timestamp,
      completenessVerified: false,
      id: "approved-1",
      language: "ru",
      manifestS3Key: input.recoveryManifestKey,
      notesSha256: sha(notes),
      notificationStatus: "held",
      notionSyncStatus: "held",
      operatorActorArn: "operator",
      originalNotesVersion: 1,
      originalTranscriptS3Key: `${folder}transcript.json`,
      transcriptSha256: sha("transcript"),
    },
  };
  const manifest = {
    id: "approved-1",
    meetingId: "meeting-1",
    language: "ru",
    approvedBy: "operator",
    approvedScope: "stored artifacts",
    nextNotesVersion: 2,
    uncertaintiesRetained: true,
    processingPartialWarningPreserved: true,
    previous: { transcriptKey: `${folder}transcript.json`, notesVersion: 1 },
    objects: [
      { role: "notes", key: `${recovery}notes.md`, sha256: sha(notes) },
      {
        role: "transcript",
        key: `${recovery}transcript.json`,
        sha256: sha("transcript"),
      },
      {
        role: "history-before",
        key: `${recovery}history-before.json`,
        sha256: sha("history"),
      },
    ],
  };
  const messages = new Map<string, DiscordEditorMessage>([
    [
      "400",
      {
        id: "400",
        channel_id: "300",
        author: { id: "500", bot: true },
        content: "",
        embeds: [
          {
            title: "Meeting Notes",
            description: "Old notes",
            color: 123,
            timestamp,
            type: "rich",
          },
        ],
        components: [
          {
            type: 1,
            components: [
              { type: 2, custom_id: "correction", label: "Correct", style: 1 },
            ],
          },
        ],
        attachments: [{ id: "600", filename: "recording.wav" }],
        flags: 0,
      },
    ],
  ]);
  const storage = {
    savePreview: jest.fn(),
    saveReceipt: jest.fn(),
    writeClaim: jest.fn(),
    readClaim: jest.fn(),
    readReceipt: jest.fn(),
  };
  const deps = {
    readHistory: jest.fn(async () => history),
    readManifest: jest.fn(async () => manifest),
    now: () => timestamp,
    discord: {
      getBotIdentity: jest.fn(async () => ({ id: "500", bot: true as const })),
      getChannel: jest.fn(async (id: string) => ({
        id,
        guild_id: "100",
        type: 0,
      })),
      getMessage: jest.fn(
        async ({ messageId }: { messageId: string }) =>
          messages.get(messageId) ?? null,
      ),
      editEmbeds: jest.fn(async () => "acknowledged" as const),
    },
    storage,
  } satisfies PublicationDependencies;
  return { history, manifest, messages, deps, storage };
}
