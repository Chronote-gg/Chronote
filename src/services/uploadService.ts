import { promises as fs } from "node:fs";
import { MeetingData } from "../types/meeting-data";
import { uploadObjectToS3 } from "./storageService";
import { config } from "./configService";
import { buildParticipantSnapshot } from "../utils/participants";
import { ChatEntry } from "../types/chat";
import { Participant } from "../types/participants";

function sanitizeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:]/g, "-");
}

function getMeetingFolder(meeting: MeetingData): string {
  const prefix = config.storage.transcriptPrefix
    ? config.storage.transcriptPrefix.replace(/\/?$/, "/")
    : "";
  return `${prefix}${meeting.guildId}/${meeting.voiceChannel.id}_${meeting.meetingId}_${sanitizeTimestamp(meeting.startTime)}/`;
}

async function ensureParticipant(
  meeting: MeetingData,
  userId: string,
): Promise<Participant | undefined> {
  const existing = meeting.participants.get(userId);
  if (existing) return existing;

  const snapshot = await buildParticipantSnapshot(meeting.guild, userId);
  if (snapshot) {
    meeting.participants.set(userId, snapshot);
  }
  return snapshot;
}

function buildTranscriptJson(
  meeting: MeetingData,
  transcriptText?: string,
  segments?: {
    userId: string;
    timestamp: number;
    text?: string;
    source?: string;
    messageId?: string;
  }[],
) {
  const resolveSegmentText = (
    file: MeetingData["audioData"]["audioFiles"][0],
  ) =>
    file.coalescedTranscript ??
    file.slowTranscript ??
    file.transcript ??
    (file.fastTranscripts && file.fastTranscripts.length > 0
      ? file.fastTranscripts[file.fastTranscripts.length - 1].text
      : undefined);
  const builtSegments =
    segments ??
    [
      ...meeting.audioData.audioFiles.map((file) => ({
        userId: file.userId,
        timestamp: file.timestamp,
        text: resolveSegmentText(file),
        source: file.source,
        messageId: file.messageId,
      })),
      ...(meeting.audioData.cueEvents?.map((cue) => ({
        userId: cue.userId,
        timestamp: cue.timestamp,
        text: cue.text,
        source: cue.source,
        messageId: undefined,
      })) ?? []),
    ].sort((a, b) => a.timestamp - b.timestamp);

  const formattedSegments = builtSegments.map((seg) => {
    const participant = meeting.participants.get(seg.userId);
    return {
      userId: seg.userId,
      username: participant?.username,
      displayName: participant?.displayName,
      serverNickname: participant?.serverNickname,
      tag: participant?.tag,
      startedAt: new Date(seg.timestamp).toISOString(),
      text: seg.text,
      source: seg.source,
      messageId: seg.messageId,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    guildId: meeting.guildId,
    channelId: meeting.channelId,
    meetingId: meeting.meetingId,
    segments: formattedSegments,
    text: transcriptText,
  };
}

function chatEntriesToJson(chatLog: ChatEntry[]) {
  return chatLog.map((entry) => ({
    type: entry.type,
    source: entry.source,
    user: entry.user,
    channelId: entry.channelId,
    content: entry.content,
    attachments: entry.attachments,
    messageId: entry.messageId,
    timestamp: entry.timestamp,
  }));
}

export interface UploadArtifactsOptions {
  audioFilePath?: string;
  chatFilePath?: string;
  transcriptText?: string;
}

export async function uploadMeetingArtifacts(
  meeting: MeetingData,
  opts: UploadArtifactsOptions,
): Promise<void> {
  if (!config.storage.transcriptBucket) {
    console.warn("TRANSCRIPTS_BUCKET not set; skipping uploads.");
    return;
  }

  const folder = getMeetingFolder(meeting);

  // Ensure participants for any audio speakers
  for (const file of meeting.audioData.audioFiles) {
    await ensureParticipant(meeting, file.userId);
  }
  if (meeting.audioData.cueEvents) {
    for (const cue of meeting.audioData.cueEvents) {
      await ensureParticipant(meeting, cue.userId);
    }
  }

  // Audio
  if (opts.audioFilePath) {
    try {
      const audioBuffer = await fs.readFile(opts.audioFilePath);
      const key = `${folder}audio_combined.mp3`;
      const uploaded = await uploadObjectToS3(key, audioBuffer, "audio/mpeg");
      if (uploaded) {
        meeting.audioS3Key = uploaded;
      }
    } catch (error) {
      console.error("Failed to read/upload audio file", error);
    }
  }

  // Chat
  if (opts.chatFilePath) {
    try {
      const chatText = await fs.readFile(opts.chatFilePath, "utf-8");
      const chatTxtKey = `${folder}chat.txt`;
      const chatJsonKey = `${folder}chat.json`;

      const txtUploaded = await uploadObjectToS3(
        chatTxtKey,
        chatText,
        "text/plain; charset=utf-8",
      );
      await uploadObjectToS3(
        chatJsonKey,
        JSON.stringify(chatEntriesToJson(meeting.chatLog), null, 2),
        "application/json",
      );

      if (txtUploaded) {
        meeting.chatS3Key = chatJsonKey; // point to structured file for lookups
      }
    } catch (error) {
      console.error("Failed to upload chat artifacts", error);
    }
  }

  // Transcript
  if (opts.transcriptText) {
    const transcriptJsonKey = `${folder}transcript.json`;

    await uploadObjectToS3(
      transcriptJsonKey,
      JSON.stringify(
        buildTranscriptJson(meeting, opts.transcriptText),
        null,
        2,
      ),
      "application/json",
    );

    meeting.transcriptS3Key = transcriptJsonKey;
  }
}
