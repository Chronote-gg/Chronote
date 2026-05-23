import { promises as fs } from "node:fs";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { ChatAttachment, ChatEntry } from "../src/types/chat";
import type { Participant } from "../src/types/participants";
import type {
  TranscriptPayload,
  TranscriptSegment,
} from "../src/types/transcript";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_END_REASON = "bot_disconnect";
const SECONDS_PER_MILLISECOND = 1 / 1000;

const recoveredSegmentSchema = z
  .object({
    speakerId: z.string().min(1),
    text: z.string().optional(),
    timestampMs: z.number().optional(),
    timestampUtc: z.string().optional(),
    audioSeconds: z.number().optional(),
  })
  .passthrough();

const recoveredTranscriptSchema = z
  .object({
    meetingId: z.string().optional(),
    segments: z.array(recoveredSegmentSchema),
  })
  .passthrough();

const discordAuthorSchema = z
  .object({
    id: z.string().optional(),
    username: z.string().optional(),
    global_name: z.string().nullable().optional(),
    discriminator: z.string().optional(),
  })
  .passthrough();

const discordAttachmentSchema = z
  .object({
    id: z.string().optional(),
    filename: z.string().optional(),
    size: z.number().optional(),
    url: z.string().optional(),
    proxy_url: z.string().optional(),
    content_type: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    duration_secs: z.number().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const discordMessageSchema = z
  .object({
    id: z.string().nullable().optional(),
    timestamp: z.string().nullable().optional(),
    channel_id: z.string().nullable().optional(),
    author: discordAuthorSchema.nullable().optional(),
    content: z.string().nullable().optional(),
    attachments: z.array(discordAttachmentSchema).nullable().optional(),
  })
  .passthrough();

const discordMessagesSchema = z
  .object({
    channels: z.array(
      z
        .object({
          messages: z.array(discordMessageSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type RecoveredSegment = z.infer<typeof recoveredSegmentSchema>;
type RecoveredTranscript = z.infer<typeof recoveredTranscriptSchema>;
type DiscordMessages = z.infer<typeof discordMessagesSchema>;
type MeetingHistoryRecord = Record<string, unknown>;

type Options = {
  apply: boolean;
  bucket?: string;
  channelIdTimestamp: string;
  discordMessagesJson?: string;
  durationSeconds?: number;
  endedAt?: string;
  endReason: string;
  guildId: string;
  keepStatus: boolean;
  meetingHistoryTable: string;
  meetingId: string;
  meetingUserIndexTable: string;
  activeMeetingTable: string;
  region: string;
  releaseActiveLease: boolean;
  skipIndex: boolean;
  transcriptJson: string;
  transcriptMd?: string;
  transcriptsPrefix: string;
  voiceChannelId?: string;
};

type PlannedUpload = {
  key: string;
  contentType: string;
  body: string;
};

type IndexRecord = {
  userId: string;
  userTimestamp: string;
  guildId: string;
  channelId_timestamp: string;
  meetingId: string;
  timestamp: string;
};

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function requireArg(name: string) {
  const value = readArg(name);
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function optionalNumberArg(name: string) {
  const value = readArg(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function usage() {
  return `Usage:
  npx ts-node scripts/recover-meeting-artifacts.ts \\
    --guild-id <guild-id> \\
    --channel-id-timestamp <voice-channel-id#start-iso> \\
    --meeting-id <meeting-id> \\
    --transcript-json <recovered-json> \\
    --bucket <transcripts-bucket> \\
    --table-prefix <dynamodb-table-prefix>

Defaults to dry-run. Add --apply to upload S3 artifacts and update DynamoDB.

Options:
  --transcript-md <path>              Optional recovered markdown transcript used for payload text.
  --discord-messages-json <path>      Optional Discord history export used for chat.json.
  --region <aws-region>               Defaults to AWS_REGION or us-east-1.
  --table-prefix <prefix>             Used for MeetingHistoryTable, MeetingUserIndexTable, ActiveMeetingTable.
  --meeting-history-table <name>      Overrides the meeting history table name.
  --meeting-user-index-table <name>   Overrides the user index table name.
  --active-meeting-table <name>       Overrides the active meeting table name.
  --transcripts-prefix <prefix>       Optional S3 prefix, same shape as TRANSCRIPTS_PREFIX.
  --duration-seconds <seconds>        Override derived duration.
  --ended-at <iso>                    Override derived end timestamp.
  --end-reason <reason>               Defaults to bot_disconnect.
  --keep-status                       Preserve the existing meeting history status.
  --skip-index                        Do not write MeetingUserIndex records.
  --release-active-lease              Delete matching ActiveMeetingTable row when applying.
  --apply                             Execute writes. Omit for dry-run.`;
}

function parseOptions(): Options {
  if (hasFlag("--help") || process.argv.length <= 2) {
    console.log(usage());
    process.exit(hasFlag("--help") ? 0 : 1);
  }

  const tablePrefix =
    readArg("--table-prefix") ?? process.env.DDB_TABLE_PREFIX ?? "";
  return {
    apply: hasFlag("--apply"),
    bucket: readArg("--bucket") ?? process.env.TRANSCRIPTS_BUCKET,
    channelIdTimestamp: requireArg("--channel-id-timestamp"),
    discordMessagesJson: readArg("--discord-messages-json"),
    durationSeconds: optionalNumberArg("--duration-seconds"),
    endedAt: readArg("--ended-at"),
    endReason: readArg("--end-reason") ?? DEFAULT_END_REASON,
    guildId: requireArg("--guild-id"),
    keepStatus: hasFlag("--keep-status"),
    meetingHistoryTable:
      readArg("--meeting-history-table") ?? `${tablePrefix}MeetingHistoryTable`,
    meetingId: requireArg("--meeting-id"),
    meetingUserIndexTable:
      readArg("--meeting-user-index-table") ??
      `${tablePrefix}MeetingUserIndexTable`,
    activeMeetingTable:
      readArg("--active-meeting-table") ?? `${tablePrefix}ActiveMeetingTable`,
    region: readArg("--region") ?? process.env.AWS_REGION ?? DEFAULT_REGION,
    releaseActiveLease: hasFlag("--release-active-lease"),
    skipIndex: hasFlag("--skip-index"),
    transcriptJson: requireArg("--transcript-json"),
    transcriptMd: readArg("--transcript-md"),
    transcriptsPrefix:
      readArg("--transcripts-prefix") ?? process.env.TRANSCRIPTS_PREFIX ?? "",
    voiceChannelId: readArg("--voice-channel-id"),
  };
}

async function parseJsonFile<T>(filePath: string, schema: z.ZodType<T>) {
  const text = await fs.readFile(filePath, "utf8");
  return schema.parse(JSON.parse(text.replace(/^\uFEFF/, "")));
}

function parseIsoOrMs(value: { timestampUtc?: string; timestampMs?: number }) {
  if (value.timestampUtc) {
    const direct = Date.parse(value.timestampUtc);
    if (Number.isFinite(direct)) return direct;
    const truncated = value.timestampUtc.replace(/\.(\d{3})\d+Z$/, ".$1Z");
    const parsed = Date.parse(truncated);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value.timestampMs !== undefined && Number.isFinite(value.timestampMs)) {
    return value.timestampMs;
  }
  return undefined;
}

function toIsoString(ms: number) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid timestamp: ${ms}`);
  }
  return date.toISOString();
}

function sanitizeTimestamp(timestamp: string) {
  return timestamp.replace(/[:]/g, "-");
}

function normalizePrefix(prefix: string) {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

function channelIdFromChannelTimestamp(channelIdTimestamp: string) {
  const [channelId] = channelIdTimestamp.split("#");
  if (!channelId) {
    throw new Error(
      "channel-id-timestamp must start with the voice channel id",
    );
  }
  return channelId;
}

function timestampFromChannelTimestamp(channelIdTimestamp: string) {
  const [, timestamp] = channelIdTimestamp.split("#");
  if (!timestamp) {
    throw new Error("channel-id-timestamp must contain a #timestamp suffix");
  }
  return timestamp;
}

function isParticipant(value: unknown): value is Participant {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "username" in value &&
    typeof value.username === "string"
  );
}

function readParticipants(history: MeetingHistoryRecord) {
  return Array.isArray(history.participants)
    ? history.participants.filter(isParticipant)
    : [];
}

function participantById(participants: Participant[]) {
  return new Map(
    participants.map((participant) => [participant.id, participant]),
  );
}

function segmentLabel(segment: TranscriptSegment) {
  return (
    segment.serverNickname ??
    segment.displayName ??
    segment.username ??
    segment.tag ??
    segment.userId
  );
}

function buildTranscriptSegments(
  recovered: RecoveredTranscript,
  participants: Participant[],
): TranscriptSegment[] {
  const participantsById = participantById(participants);
  const segments: TranscriptSegment[] = [];
  for (const segment of recovered.segments) {
    const text = segment.text?.trim();
    if (!text) continue;
    const startedAtMs = parseIsoOrMs(segment);
    if (startedAtMs === undefined) continue;
    const participant = participantsById.get(segment.speakerId);
    segments.push({
      userId: segment.speakerId,
      username: participant?.username,
      displayName: participant?.displayName,
      serverNickname: participant?.serverNickname,
      tag: participant?.tag,
      startedAt: toIsoString(startedAtMs),
      text,
      source: "voice",
    });
  }
  return segments.sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
}

function buildTranscriptText(segments: TranscriptSegment[]) {
  return segments
    .map((segment) => {
      const label = segmentLabel(segment);
      return `[${label} @ ${segment.startedAt}]: ${segment.text ?? ""}`;
    })
    .join("\n");
}

async function readTranscriptText(
  options: Options,
  segments: TranscriptSegment[],
) {
  if (!options.transcriptMd) return buildTranscriptText(segments);
  return fs.readFile(options.transcriptMd, "utf8");
}

function buildTranscriptPayload(options: {
  guildId: string;
  channelId: string;
  meetingId: string;
  segments: TranscriptSegment[];
  text: string;
}) {
  const payload: TranscriptPayload & {
    guildId: string;
    channelId: string;
    meetingId: string;
  } = {
    generatedAt: new Date().toISOString(),
    guildId: options.guildId,
    channelId: options.channelId,
    meetingId: options.meetingId,
    segments: options.segments,
    text: options.text,
  };
  return payload;
}

function normalizeAttachment(
  attachment: z.infer<typeof discordAttachmentSchema>,
): ChatAttachment | undefined {
  if (!attachment.id || !attachment.filename || !attachment.url)
    return undefined;
  const normalized: ChatAttachment = {
    id: attachment.id,
    name: attachment.filename,
    size: attachment.size ?? 0,
    url: attachment.url,
  };
  if (attachment.proxy_url) normalized.proxyUrl = attachment.proxy_url;
  if (attachment.content_type) normalized.contentType = attachment.content_type;
  if (attachment.width !== null && attachment.width !== undefined) {
    normalized.width = attachment.width;
  }
  if (attachment.height !== null && attachment.height !== undefined) {
    normalized.height = attachment.height;
  }
  if (
    attachment.duration_secs !== null &&
    attachment.duration_secs !== undefined
  ) {
    normalized.durationSeconds = attachment.duration_secs;
  }
  if (attachment.description) normalized.description = attachment.description;
  return normalized;
}

function normalizeDiscordTimestamp(timestamp: string) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function buildChatEntries(discordMessages: DiscordMessages | undefined) {
  if (!discordMessages) return [];
  const entries: ChatEntry[] = [];
  for (const channel of discordMessages.channels) {
    for (const message of channel.messages) {
      const messageId = message.id ?? undefined;
      const channelId = message.channel_id ?? undefined;
      const timestamp = message.timestamp
        ? normalizeDiscordTimestamp(message.timestamp)
        : undefined;
      const authorId = message.author?.id;
      if (!messageId || !channelId || !timestamp || !authorId) continue;

      const attachments = (message.attachments ?? [])
        .map(normalizeAttachment)
        .filter(
          (attachment): attachment is ChatAttachment =>
            attachment !== undefined,
        );
      const content = message.content ?? "";
      if (!content.trim() && attachments.length === 0) continue;

      entries.push({
        type: "message",
        source: "chat",
        user: {
          id: authorId,
          username: message.author?.username ?? authorId,
          displayName: message.author?.global_name ?? undefined,
          tag:
            message.author?.username && message.author?.discriminator
              ? `${message.author.username}#${message.author.discriminator}`
              : message.author?.username,
        },
        channelId,
        content,
        attachments,
        messageId,
        timestamp,
      });
    }
  }
  return entries.sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}

function deriveDurationSeconds(options: {
  durationOverride?: number;
  endedAtOverride?: string;
  existingDuration?: unknown;
  meetingStartTimestamp: string;
  recoveredSegments: RecoveredSegment[];
}) {
  if (options.durationOverride !== undefined) return options.durationOverride;
  const startMs = Date.parse(options.meetingStartTimestamp);
  if (!Number.isFinite(startMs)) {
    throw new Error(
      `Invalid meeting start timestamp: ${options.meetingStartTimestamp}`,
    );
  }
  if (options.endedAtOverride) {
    const endedAtMs = Date.parse(options.endedAtOverride);
    if (!Number.isFinite(endedAtMs)) {
      throw new Error(
        `Invalid --ended-at timestamp: ${options.endedAtOverride}`,
      );
    }
    return Math.max(
      0,
      Math.ceil((endedAtMs - startMs) * SECONDS_PER_MILLISECOND),
    );
  }
  const segmentEndTimes = options.recoveredSegments
    .map((segment) => {
      const segmentStart = parseIsoOrMs(segment);
      if (segmentStart === undefined) return undefined;
      const audioMs = (segment.audioSeconds ?? 0) * 1000;
      return segmentStart + audioMs;
    })
    .filter((value): value is number => value !== undefined);
  if (segmentEndTimes.length === 0) {
    const existing =
      typeof options.existingDuration === "number" &&
      Number.isFinite(options.existingDuration)
        ? options.existingDuration
        : 0;
    return existing;
  }
  const latestSegmentEndMs = Math.max(...segmentEndTimes);
  const derived = Math.max(
    0,
    Math.ceil((latestSegmentEndMs - startMs) * SECONDS_PER_MILLISECOND),
  );
  const existing =
    typeof options.existingDuration === "number" &&
    Number.isFinite(options.existingDuration)
      ? options.existingDuration
      : 0;
  return Math.max(existing, derived);
}

function buildMeetingFolder(options: {
  channelId: string;
  guildId: string;
  meetingId: string;
  timestamp: string;
  transcriptsPrefix: string;
}) {
  return `${normalizePrefix(options.transcriptsPrefix)}${options.guildId}/${options.channelId}_${options.meetingId}_${sanitizeTimestamp(options.timestamp)}/`;
}

function buildIndexRecords(history: MeetingHistoryRecord): IndexRecord[] {
  const userIds = new Set<string>();
  for (const participant of readParticipants(history)) {
    if (participant.id.trim()) userIds.add(participant.id.trim());
  }
  if (Array.isArray(history.attendees)) {
    for (const attendee of history.attendees) {
      if (typeof attendee !== "string") continue;
      const match = attendee.trim().match(/^<@!?(\d+)>$/);
      if (match) userIds.add(match[1]);
    }
  }
  if (
    typeof history.meetingCreatorId === "string" &&
    history.meetingCreatorId.trim()
  ) {
    userIds.add(history.meetingCreatorId.trim());
  }
  if (
    typeof history.startTriggeredByUserId === "string" &&
    history.startTriggeredByUserId.trim()
  ) {
    userIds.add(history.startTriggeredByUserId.trim());
  }

  const timestamp = String(history.timestamp ?? "");
  const guildId = String(history.guildId ?? "");
  const channelIdTimestamp = String(history.channelId_timestamp ?? "");
  const meetingId = String(history.meetingId ?? "");
  const userTimestamp = [timestamp, guildId, channelIdTimestamp].join("#");

  return Array.from(userIds).map((userId) => ({
    userId,
    userTimestamp,
    guildId,
    channelId_timestamp: channelIdTimestamp,
    meetingId,
    timestamp,
  }));
}

async function getMeetingHistory(
  client: DynamoDBClient,
  tableName: string,
  options: Options,
) {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({
        guildId: options.guildId,
        channelId_timestamp: options.channelIdTimestamp,
      }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    throw new Error(
      `Meeting history not found in ${tableName} for the supplied guild/channel timestamp`,
    );
  }
  return unmarshall(result.Item);
}

async function getActiveMeetingLease(
  client: DynamoDBClient,
  tableName: string,
  guildId: string,
) {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ guildId }),
      ConsistentRead: true,
    }),
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}

async function putObject(s3: S3Client, bucket: string, upload: PlannedUpload) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: upload.key,
      Body: upload.body,
      ContentType: upload.contentType,
    }),
  );
}

async function writeHistory(
  client: DynamoDBClient,
  tableName: string,
  history: MeetingHistoryRecord,
) {
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(history, { removeUndefinedValues: true }),
      ConditionExpression: "#meetingId = :meetingId",
      ExpressionAttributeNames: { "#meetingId": "meetingId" },
      ExpressionAttributeValues: marshall({ ":meetingId": history.meetingId }),
    }),
  );
}

async function writeIndexRecords(
  client: DynamoDBClient,
  tableName: string,
  records: IndexRecord[],
) {
  for (const record of records) {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }
}

async function releaseActiveLease(
  client: DynamoDBClient,
  tableName: string,
  lease: MeetingHistoryRecord,
) {
  await client.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ guildId: lease.guildId }),
      ConditionExpression:
        "#meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId",
      ExpressionAttributeNames: {
        "#meetingId": "meetingId",
        "#ownerInstanceId": "ownerInstanceId",
      },
      ExpressionAttributeValues: marshall({
        ":meetingId": lease.meetingId,
        ":ownerInstanceId": lease.ownerInstanceId,
      }),
    }),
  );
}

function printPlan(options: {
  activeLease?: MeetingHistoryRecord;
  chatEntryCount: number;
  durationSeconds: number;
  historyTable: string;
  indexRecordCount: number;
  mode: "APPLY" | "DRY RUN";
  options: Options;
  transcriptSegmentCount: number;
  uploads: PlannedUpload[];
}) {
  console.log(`Mode: ${options.mode}`);
  console.log(`Meeting: ${options.options.meetingId}`);
  console.log(`Transcript segments: ${options.transcriptSegmentCount}`);
  console.log(`Recovered chat entries: ${options.chatEntryCount}`);
  console.log(`Duration seconds: ${options.durationSeconds}`);
  console.log(`Meeting history table: ${options.historyTable}`);
  console.log(`Meeting user index records: ${options.indexRecordCount}`);
  console.log("Planned S3 uploads:");
  if (options.uploads.length === 0) {
    console.log("  none");
  }
  for (const upload of options.uploads) {
    console.log(
      `  s3://${options.options.bucket}/${upload.key} (${upload.contentType})`,
    );
  }
  console.log("Planned DynamoDB updates:");
  console.log(
    "  put merged MeetingHistory record with recovered artifact keys",
  );
  if (!options.options.skipIndex) {
    console.log("  put MeetingUserIndex records for indexed meeting users");
  }
  if (options.options.releaseActiveLease) {
    const activeMeetingId = options.activeLease?.meetingId;
    const status =
      activeMeetingId === options.options.meetingId
        ? "matching"
        : "not matching";
    console.log(`  release ActiveMeeting lease: ${status}`);
  }
}

async function main() {
  const options = parseOptions();
  const dynamo = new DynamoDBClient({ region: options.region });
  const s3 = new S3Client({ region: options.region });

  const recovered = await parseJsonFile(
    options.transcriptJson,
    recoveredTranscriptSchema,
  );
  if (recovered.meetingId && recovered.meetingId !== options.meetingId) {
    throw new Error(
      "Recovered transcript meetingId does not match --meeting-id",
    );
  }
  const existingHistory = await getMeetingHistory(
    dynamo,
    options.meetingHistoryTable,
    options,
  );
  if (existingHistory.meetingId !== options.meetingId) {
    throw new Error(
      "Existing meeting history meetingId does not match --meeting-id",
    );
  }

  const channelId =
    options.voiceChannelId ??
    (typeof existingHistory.channelId === "string"
      ? existingHistory.channelId
      : channelIdFromChannelTimestamp(options.channelIdTimestamp));
  const timestamp =
    typeof existingHistory.timestamp === "string"
      ? existingHistory.timestamp
      : timestampFromChannelTimestamp(options.channelIdTimestamp);
  const participants = readParticipants(existingHistory);
  const transcriptSegments = buildTranscriptSegments(recovered, participants);
  const transcriptText = await readTranscriptText(options, transcriptSegments);
  const transcriptPayload = buildTranscriptPayload({
    guildId: options.guildId,
    channelId,
    meetingId: options.meetingId,
    segments: transcriptSegments,
    text: transcriptText,
  });
  const discordMessages = options.discordMessagesJson
    ? await parseJsonFile(options.discordMessagesJson, discordMessagesSchema)
    : undefined;
  const chatEntries = buildChatEntries(discordMessages);

  const folder = buildMeetingFolder({
    channelId,
    guildId: options.guildId,
    meetingId: options.meetingId,
    timestamp,
    transcriptsPrefix: options.transcriptsPrefix,
  });
  const transcriptS3Key = `${folder}transcript.json`;
  const chatS3Key = `${folder}chat.json`;
  const durationSeconds = deriveDurationSeconds({
    durationOverride: options.durationSeconds,
    endedAtOverride: options.endedAt,
    existingDuration: existingHistory.duration,
    meetingStartTimestamp: timestamp,
    recoveredSegments: recovered.segments,
  });
  const endedAt =
    options.endedAt ??
    toIsoString(Date.parse(timestamp) + durationSeconds * 1000);

  const uploads: PlannedUpload[] = [
    {
      key: transcriptS3Key,
      contentType: "application/json",
      body: JSON.stringify(transcriptPayload, null, 2),
    },
  ];
  if (chatEntries.length > 0) {
    uploads.push({
      key: chatS3Key,
      contentType: "application/json",
      body: JSON.stringify(chatEntries, null, 2),
    });
  }

  const updatedHistory: MeetingHistoryRecord = {
    ...existingHistory,
    channelId,
    duration: durationSeconds,
    endReason: existingHistory.endReason ?? options.endReason,
    endedAt,
    status: options.keepStatus ? existingHistory.status : "complete",
    transcriptS3Key,
    ...(chatEntries.length > 0 ? { chatS3Key } : {}),
  };
  const indexRecords = buildIndexRecords(updatedHistory);
  const activeLease = options.releaseActiveLease
    ? await getActiveMeetingLease(
        dynamo,
        options.activeMeetingTable,
        options.guildId,
      )
    : undefined;

  if (!options.bucket) {
    throw new Error(
      "Missing --bucket or TRANSCRIPTS_BUCKET for planned S3 uploads",
    );
  }

  printPlan({
    activeLease,
    chatEntryCount: chatEntries.length,
    durationSeconds,
    historyTable: options.meetingHistoryTable,
    indexRecordCount: indexRecords.length,
    mode: options.apply ? "APPLY" : "DRY RUN",
    options,
    transcriptSegmentCount: transcriptSegments.length,
    uploads,
  });

  if (!options.apply) return;

  for (const upload of uploads) {
    await putObject(s3, options.bucket, upload);
  }
  await writeHistory(dynamo, options.meetingHistoryTable, updatedHistory);
  if (!options.skipIndex) {
    await writeIndexRecords(
      dynamo,
      options.meetingUserIndexTable,
      indexRecords,
    );
  }
  if (
    options.releaseActiveLease &&
    activeLease?.meetingId === options.meetingId &&
    activeLease.ownerInstanceId
  ) {
    await releaseActiveLease(dynamo, options.activeMeetingTable, activeLease);
  }
  console.log("Recovery writes completed.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Recovery failed: ${message}`);
  process.exit(1);
});
