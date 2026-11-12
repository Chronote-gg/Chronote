import { promises as fs } from "node:fs";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import { meetingFinishes, meetingsCancelled } from "../metrics";
import { captureHistoryMeetingCompleted } from "../observability/meetingCompletionAnalytics";
import { resolveHistoryActorId } from "../utils/meetingLifecycle";
import { discordEditorMessageSchema } from "./discordMessageEditor";
import type { DeliveryTransport } from "./meetingDelivery";
import type { FinishInput } from "./meetingFinishInput";
import { writeMeetingUserIndexForMeetingService } from "./meetingUserIndexService";
import { maybeAutoExportCompletedMeeting } from "./notionAutomationService";
import { registerNotionMutationTracker } from "./notionOperationLifetime";
import {
  notifyRecordingLimit,
  weeklyLimitNoticeAfterMeeting,
  type NoticeChannel,
  type RecordingLimitState,
} from "./recordingLimitService";
import type { uploadVerifiedObjectToS3 } from "./storageService";
import { getRecordingArtifactFolder } from "./uploadService";

const createdMessageSchema = discordEditorMessageSchema.pick({ id: true });

/** Steps 5 and 6 of the finish pipeline: follow-ons and the recording upload. */
export type FinishFollowOns = {
  exportToNotion(history: MeetingHistory, signal: AbortSignal): Promise<void>;
  writeUserIndex(history: MeetingHistory): Promise<void>;
  captureCompleted(history: MeetingHistory): void;
  sendWeeklyLimitNotice(
    history: MeetingHistory,
    state: RecordingLimitState | undefined,
    signal: AbortSignal,
  ): Promise<void>;
};

/** What the follow-ons see of one finish attempt. */
export type FollowOnAttempt = {
  row(): MeetingHistory;
  signal: AbortSignal;
  /** Delivery had settled before this attempt claimed the row. */
  settledAtClaim: boolean;
  deliver: boolean;
  /** The input this attempt loaded, when it processed the meeting. */
  input?: FinishInput;
  /** Loads the input once, only to recover the recording on a later attempt. */
  loadForRecording(): Promise<FinishInput>;
  save(patch: Partial<MeetingHistory>): Promise<MeetingHistory>;
  upload: typeof uploadVerifiedObjectToS3;
  followOns: FinishFollowOns;
};

const logContext = (row: MeetingHistory) => ({
  guildId: row.guildId,
  meetingId: row.meetingId,
});

/** The folder today's live upload writes to, or the checkpoint's own. */
export function meetingArtifactFolder(row: MeetingHistory): string {
  return (
    row.checkpoint?.artifactFolder ??
    getRecordingArtifactFolder({
      guildId: row.guildId,
      channelId: row.channelId,
      meetingId: row.meetingId,
      reservedAt: row.timestamp,
    })
  );
}

async function guarded(a: FollowOnAttempt, name: string, run: () => unknown) {
  try {
    await run();
  } catch (error) {
    if (a.signal.aborted) throw error;
    console.warn(`Meeting finish follow-on failed: ${name}`, {
      ...logContext(a.row()),
      error,
    });
  }
}

/** Step 5, best effort: a failure is logged and counted and never changes the outcome. */
export async function uploadRecording(
  a: FollowOnAttempt,
  input: FinishInput | undefined,
): Promise<void> {
  const row = a.row();
  if (!input?.recordingPath || row.audioS3Key) return;
  try {
    const stored = await a.upload(
      `${meetingArtifactFolder(row)}audio_combined.mp3`,
      await fs.readFile(input.recordingPath),
      "audio/mpeg",
      { signal: a.signal },
    );
    if (!stored) throw new Error("Meeting recording upload was not stored");
    await a.save({ audioS3Key: stored.key });
  } catch (error) {
    if (a.signal.aborted) throw error;
    meetingFinishes.inc({ outcome: "recording_upload_failed" });
    console.error("Meeting recording upload failed", {
      ...logContext(row),
      error,
    });
  }
}

/**
 * A later attempt loads the input again only when the recovery loader can
 * render the mix without provider work: the transcript is already stored, or
 * transcription is off. Otherwise it would transcribe pieces again for a
 * meeting whose result is already delivered, so the recording is skipped.
 */
function recordingRecoverable(row: MeetingHistory): boolean {
  return (
    !row.audioS3Key &&
    row.checkpoint !== undefined &&
    (row.transcriptS3Key !== undefined || !row.transcribeMeeting)
  );
}

async function recordingInput(
  a: FollowOnAttempt,
): Promise<FinishInput | undefined> {
  if (a.input) return a.input;
  if (!recordingRecoverable(a.row())) return undefined;
  try {
    return await a.loadForRecording();
  } catch (error) {
    if (a.signal.aborted) throw error;
    console.error("Meeting recording could not be loaded", {
      ...logContext(a.row()),
      error,
    });
    return undefined;
  }
}

/**
 * Step 6 then step 5, quickest first so a stop loses as little as possible.
 * The user index and Notion export guard themselves and run on every attempt.
 * Analytics, the cancellation count and the weekly notice have no guard: they
 * run once, in the attempt that settled delivery. The weekly notice needs the
 * live meeting's notice state, so only the normal loader's attempt sends it.
 */
export async function runFollowOns(a: FollowOnAttempt): Promise<void> {
  const row = a.row();
  await guarded(a, "user index", () => a.followOns.writeUserIndex(row));
  if (row.status === MEETING_STATUS.FAILED) return;
  const finished =
    row.status === MEETING_STATUS.COMPLETE ||
    row.status === MEETING_STATUS.INTERRUPTED;
  if (!a.settledAtClaim) {
    if (row.status === MEETING_STATUS.CANCELLED) meetingsCancelled.inc();
    a.followOns.captureCompleted(row);
    if (finished && a.deliver && a.input?.source === "normal") {
      const state = a.input.recordingLimitNotice;
      await guarded(a, "weekly limit notice", () =>
        a.followOns.sendWeeklyLimitNotice(row, state, a.signal),
      );
    }
  }
  if (finished)
    await guarded(a, "Notion export", () =>
      a.followOns.exportToNotion(row, a.signal),
    );
  await uploadRecording(a, await recordingInput(a));
}

function toRest(payload: MessageCreateOptions | MessageEditOptions) {
  return {
    content: payload.content ?? undefined,
    // Builders serialize through toJSON, so this yields Discord's wire shape.
    components: JSON.parse(JSON.stringify(payload.components ?? [])),
    allowed_mentions: { parse: [] },
  };
}

/** The recording limit service's channel, over REST to the channel on the row. */
export function restNoticeChannel(
  transport: DeliveryTransport,
  channelId: string,
  signal: AbortSignal,
): NoticeChannel {
  return {
    async send(payload) {
      const created = createdMessageSchema.parse(
        await transport.createMessage({
          channelId,
          payload: toRest(payload),
          signal,
        }),
      );
      return {
        edit: (edit: MessageEditOptions) =>
          transport.updateMessage({
            channelId,
            messageId: created.id,
            payload: toRest(edit),
            signal,
          }),
      };
    },
  };
}

/** Notion mutations need an owner; the finish attempt owns this one for its duration. */
async function exportToNotion(history: MeetingHistory, signal: AbortSignal) {
  const owned = AbortSignal.any([signal]);
  const unregister = registerNotionMutationTracker(owned, (run) => run());
  try {
    await maybeAutoExportCompletedMeeting(history, owned);
  } finally {
    unregister();
  }
}

export function defaultFinishFollowOns(
  transport: DeliveryTransport,
): FinishFollowOns {
  return {
    exportToNotion,
    writeUserIndex: writeMeetingUserIndexForMeetingService,
    captureCompleted: captureHistoryMeetingCompleted,
    async sendWeeklyLimitNotice(history, state, signal) {
      if (!history.textChannelId) return;
      const notice = await weeklyLimitNoticeAfterMeeting({
        guildId: history.guildId,
        userId: resolveHistoryActorId(history),
        signal,
      });
      if (!notice) return;
      await notifyRecordingLimit(
        notice,
        restNoticeChannel(transport, history.textChannelId, signal),
        state,
      );
    },
  };
}
