import { getFeedbackRepository } from "../repositories/feedbackRepository";
import { captureEvent } from "./analyticsService";
import type {
  FeedbackRating,
  FeedbackRecord,
  FeedbackSource,
} from "../types/db";
import { nowIso } from "../utils/time";
import {
  buildFeedbackPk,
  buildFeedbackSk,
  normalizeFeedbackComment,
} from "./feedbackHelpers";

const buildAskTargetId = (params: {
  conversationId?: string;
  channelId?: string;
  messageId: string;
}) => {
  const scopeId = params.conversationId ?? params.channelId;
  if (!scopeId) {
    throw new Error("Ask feedback requires a conversation or channel id.");
  }
  return `${scopeId}#${params.messageId}`;
};

export async function submitAskFeedback(params: {
  guildId: string;
  userId: string;
  userTag?: string;
  displayName?: string;
  rating: FeedbackRating;
  comment?: string;
  source?: FeedbackSource;
  conversationId?: string;
  channelId?: string;
  messageId: string;
}) {
  const comment = normalizeFeedbackComment(params.comment);
  const now = nowIso();
  const targetId = buildAskTargetId({
    conversationId: params.conversationId,
    channelId: params.channelId,
    messageId: params.messageId,
  });

  const record: FeedbackRecord = {
    pk: buildFeedbackPk("ask_answer", targetId),
    sk: buildFeedbackSk(params.userId),
    type: "feedback",
    targetType: "ask_answer",
    targetId,
    guildId: params.guildId,
    channelId: params.channelId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    rating: params.rating,
    comment,
    source: params.source ?? "web",
    createdAt: now,
    updatedAt: now,
    userId: params.userId,
    userTag: params.userTag,
    displayName: params.displayName,
  };

  await getFeedbackRepository().write(record);

  captureEvent("feedback_submitted", {
    userId: params.userId,
    guildId: params.guildId,
    properties: {
      target: "ask_answer",
      rating: params.rating,
      surface: record.source,
      has_comment: Boolean(comment),
    },
  });

  return {
    ok: true as const,
    record,
  };
}
