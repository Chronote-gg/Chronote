import { getFeedbackRepository } from "../repositories/feedbackRepository";
import { captureEvent } from "./analyticsService";
import type {
  FeedbackRating,
  FeedbackRecord,
  FeedbackSource,
} from "../types/db";
import { nowIso } from "../utils/time";
import { getMeetingHistoryService } from "./meetingHistoryService";
import {
  buildFeedbackPk,
  buildFeedbackSk,
  normalizeFeedbackComment,
} from "./feedbackHelpers";

export const buildMeetingSummaryFeedbackKeys = (params: {
  channelIdTimestamp: string;
  userId: string;
}) => ({
  pk: buildFeedbackPk("meeting_summary", params.channelIdTimestamp),
  sk: buildFeedbackSk(params.userId),
});

export async function getMeetingSummaryFeedback(params: {
  channelIdTimestamp: string;
  userId: string;
}) {
  const { pk, sk } = buildMeetingSummaryFeedbackKeys(params);
  return getFeedbackRepository().get(pk, sk);
}

export async function submitMeetingSummaryFeedback(params: {
  guildId: string;
  channelIdTimestamp: string;
  userId: string;
  userTag?: string;
  displayName?: string;
  rating: FeedbackRating;
  comment?: string;
  source?: FeedbackSource;
}) {
  const history = await getMeetingHistoryService(
    params.guildId,
    params.channelIdTimestamp,
  );

  const comment = normalizeFeedbackComment(params.comment);
  const now = nowIso();

  const channelId =
    history?.channelId ?? params.channelIdTimestamp.split("#")[0];
  const record: FeedbackRecord = {
    pk: buildFeedbackPk("meeting_summary", params.channelIdTimestamp),
    sk: buildFeedbackSk(params.userId),
    type: "feedback",
    targetType: "meeting_summary",
    targetId: params.channelIdTimestamp,
    guildId: params.guildId,
    channelId,
    meetingId: history?.meetingId,
    notesVersion: history?.notesVersion,
    summarySentence: history?.summarySentence,
    summaryLabel: history?.summaryLabel,
    rating: params.rating,
    comment,
    source: params.source ?? "discord",
    createdAt: now,
    updatedAt: now,
    userId: params.userId,
    userTag: params.userTag,
    displayName: params.displayName,
  };

  await getFeedbackRepository().write(record);

  // Downvotes feed the eval harvest, so the rating and surface are worth
  // tracking as a trend. The comment itself is user content and stays out.
  captureEvent("feedback_submitted", {
    userId: params.userId,
    guildId: params.guildId,
    properties: {
      target: "meeting_summary",
      rating: params.rating,
      surface: record.source,
      has_comment: Boolean(comment),
    },
  });

  return {
    ok: true as const,
    record,
    historyFound: Boolean(history),
  };
}
