import { v4 as uuid } from "uuid";
import { answerQuestionService } from "./askService";
import { getAskConversationRepository } from "../repositories/askConversationRepository";
import type {
  AskConversation,
  AskConversationVisibility,
  AskMessage,
} from "../types/ask";
import { nowIso } from "../utils/time";
import { config } from "./configService";
import { renderAskAnswer, stripCitationTags } from "./askCitations";

const DEFAULT_TITLE = "New question";

const truncate = (text: string, maxLen: number) =>
  text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;

const summarize = (text: string) =>
  truncate(text.replace(/\s+/g, " ").trim(), 160);

const resolvePortalBaseUrl = () =>
  config.frontend.siteUrl.trim().replace(/\/$/, "");

const renderMessageForDisplay = (options: {
  message: AskMessage;
  guildId: string;
  portalBaseUrl: string;
}): AskMessage => {
  if (options.message.role !== "chronote") {
    return { ...options.message };
  }
  const rendered = renderAskAnswer({
    text: options.message.text,
    citations: options.message.citations ?? [],
    guildId: options.guildId,
    portalBaseUrl: options.portalBaseUrl,
  });
  return {
    ...options.message,
    text: rendered,
  };
};

const buildConversation = (
  userId: string,
  guildId: string,
  conversationId?: string,
): AskConversation => {
  const now = nowIso();
  return {
    id: conversationId ?? uuid(),
    title: DEFAULT_TITLE,
    summary: "",
    createdAt: now,
    updatedAt: now,
    visibility: "private",
  };
};

const buildShareRecord = (options: {
  guildId: string;
  ownerUserId: string;
  ownerTag?: string;
  conversation: AskConversation;
  sharedAt: string;
  sharedByUserId: string;
  sharedByTag?: string;
}) => {
  const {
    guildId,
    ownerUserId,
    ownerTag,
    conversation,
    sharedAt,
    sharedByUserId,
    sharedByTag,
  } = options;
  return {
    pk: `GUILD#${guildId}`,
    sk: `SHARE#${conversation.id}`,
    type: "share" as const,
    conversationId: conversation.id,
    guildId,
    ownerUserId,
    ownerTag,
    title: conversation.title,
    summary: conversation.summary,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    sharedAt,
    sharedByUserId,
    sharedByTag,
    archivedAt: conversation.archivedAt,
    archivedByUserId: conversation.archivedByUserId,
  };
};

const isSharedVisibility = (visibility?: AskConversationVisibility) =>
  visibility === "server" || visibility === "public";

export async function listAskConversations(userId: string, guildId: string) {
  const repo = getAskConversationRepository();
  const conversations = await repo.listConversations(userId, guildId);
  return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listSharedAskConversations(
  guildId: string,
  viewerUserId: string,
) {
  const repo = getAskConversationRepository();
  const conversations = await repo.listSharedConversations(guildId);
  return conversations
    .filter((conv) => conv.ownerUserId !== viewerUserId)
    .filter((conv) => !conv.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getAskConversationWithMessages(
  userId: string,
  guildId: string,
  conversationId: string,
) {
  const repo = getAskConversationRepository();
  const conversation = await repo.getConversation(
    userId,
    guildId,
    conversationId,
  );
  if (!conversation) {
    return undefined;
  }
  const messages = await repo.listMessages(userId, guildId, conversationId);
  const portalBaseUrl = resolvePortalBaseUrl();
  return {
    conversation,
    messages: messages.map((message) =>
      renderMessageForDisplay({ message, guildId, portalBaseUrl }),
    ),
  };
}

export async function getSharedConversationWithMessages(
  guildId: string,
  conversationId: string,
) {
  const repo = getAskConversationRepository();
  const shared = await repo.getSharedConversation(guildId, conversationId);
  if (!shared) {
    return undefined;
  }
  const conversation = await repo.getConversation(
    shared.ownerUserId,
    guildId,
    conversationId,
  );
  if (!conversation || !isSharedVisibility(conversation.visibility)) {
    return undefined;
  }
  const messages = await repo.listMessages(
    shared.ownerUserId,
    guildId,
    conversationId,
  );
  const portalBaseUrl = resolvePortalBaseUrl();
  return {
    conversation,
    messages: messages.map((message) =>
      renderMessageForDisplay({ message, guildId, portalBaseUrl }),
    ),
    shared,
  };
}

export async function renameAskConversation(
  userId: string,
  guildId: string,
  conversationId: string,
  title: string,
) {
  const repo = getAskConversationRepository();
  const existing = await repo.getConversation(userId, guildId, conversationId);
  if (!existing) {
    return undefined;
  }
  const updated: AskConversation = {
    ...existing,
    title,
    updatedAt: nowIso(),
  };
  await repo.writeConversation(userId, guildId, updated);
  if (isSharedVisibility(updated.visibility) && updated.sharedAt) {
    await repo.writeSharedConversation(
      buildShareRecord({
        guildId,
        ownerUserId: userId,
        ownerTag: updated.sharedByTag,
        conversation: updated,
        sharedAt: updated.sharedAt,
        sharedByUserId: updated.sharedByUserId ?? userId,
        sharedByTag: updated.sharedByTag,
      }),
    );
  }
  return updated;
}

export async function setAskConversationVisibility(params: {
  userId: string;
  guildId: string;
  conversationId: string;
  visibility: AskConversationVisibility;
  sharedByTag?: string;
}) {
  const repo = getAskConversationRepository();
  const { userId, guildId, conversationId, visibility, sharedByTag } = params;
  const existing = await repo.getConversation(userId, guildId, conversationId);
  if (!existing) {
    return undefined;
  }
  const now = nowIso();
  const isShared = isSharedVisibility(visibility);
  const updated: AskConversation = {
    ...existing,
    visibility,
    sharedAt: isShared ? now : undefined,
    sharedByUserId: isShared ? userId : undefined,
    sharedByTag: isShared ? sharedByTag : undefined,
    updatedAt: now,
  };
  await repo.writeConversation(userId, guildId, updated);
  if (isShared) {
    await repo.writeSharedConversation(
      buildShareRecord({
        guildId,
        ownerUserId: userId,
        ownerTag: sharedByTag,
        conversation: updated,
        sharedAt: updated.sharedAt ?? now,
        sharedByUserId: userId,
        sharedByTag,
      }),
    );
  } else {
    await repo.deleteSharedConversation(guildId, conversationId);
  }
  return updated;
}

export async function setAskConversationArchived(params: {
  userId: string;
  guildId: string;
  conversationId: string;
  archived: boolean;
}) {
  const repo = getAskConversationRepository();
  const { userId, guildId, conversationId, archived } = params;
  const existing = await repo.getConversation(userId, guildId, conversationId);
  if (!existing) {
    return undefined;
  }
  const now = nowIso();
  const updated: AskConversation = {
    ...existing,
    archivedAt: archived ? now : undefined,
    archivedByUserId: archived ? userId : undefined,
    updatedAt: now,
  };
  await repo.writeConversation(userId, guildId, updated);
  if (isSharedVisibility(updated.visibility) && updated.sharedAt) {
    await repo.writeSharedConversation(
      buildShareRecord({
        guildId,
        ownerUserId: userId,
        ownerTag: updated.sharedByTag,
        conversation: updated,
        sharedAt: updated.sharedAt,
        sharedByUserId: updated.sharedByUserId ?? userId,
        sharedByTag: updated.sharedByTag,
      }),
    );
  }
  return updated;
}

export async function askWithConversation(params: {
  userId: string;
  guildId: string;
  question: string;
  conversationId?: string;
  channelId?: string;
  tags?: string[];
  scope?: "guild" | "channel";
  viewerUserId?: string;
  contextMeetingIds?: string[];
}) {
  const repo = getAskConversationRepository();
  const {
    userId,
    guildId,
    question,
    conversationId,
    channelId,
    tags,
    scope,
    viewerUserId,
  } = params;
  const existing = conversationId
    ? await repo.getConversation(userId, guildId, conversationId)
    : undefined;
  const conversation =
    existing ?? buildConversation(userId, guildId, conversationId);
  const priorMessages = existing
    ? await repo.listMessages(userId, guildId, conversation.id)
    : [];
  if (!existing) {
    await repo.writeConversation(userId, guildId, conversation);
  }

  const userMessage: AskMessage = {
    id: uuid(),
    role: "user",
    text: question,
    createdAt: nowIso(),
  };
  await repo.writeMessage(userId, guildId, conversation.id, userMessage);

  const history = priorMessages.slice(-10).map((message) => ({
    role: message.role,
    text: message.text,
  }));

  const {
    answer: rawAnswer,
    sourceMeetingIds,
    citations,
  } = await answerQuestionService({
    guildId,
    channelId: channelId ?? "",
    question,
    tags,
    scope,
    history,
    viewerUserId,
    contextMeetingIds: params.contextMeetingIds,
  });
  const resolvedCitations = citations ?? [];
  const portalBaseUrl = resolvePortalBaseUrl();
  const renderedAnswer = renderAskAnswer({
    text: rawAnswer,
    citations: resolvedCitations,
    guildId,
    portalBaseUrl,
  });

  const replyMessage: AskMessage = {
    id: uuid(),
    role: "chronote",
    text: rawAnswer,
    createdAt: nowIso(),
    sourceMeetingIds,
    citations: resolvedCitations,
  };
  await repo.writeMessage(userId, guildId, conversation.id, replyMessage);

  const shouldUpdateTitle =
    conversation.title === DEFAULT_TITLE ||
    conversation.title.trim().length === 0;
  const updatedConversation: AskConversation = {
    ...conversation,
    title: shouldUpdateTitle ? truncate(question, 80) : conversation.title,
    summary: summarize(stripCitationTags(rawAnswer)) || conversation.summary,
    updatedAt: nowIso(),
  };
  await repo.writeConversation(userId, guildId, updatedConversation);
  if (isSharedVisibility(updatedConversation.visibility)) {
    const sharedAt = updatedConversation.sharedAt ?? nowIso();
    await repo.writeSharedConversation(
      buildShareRecord({
        guildId,
        ownerUserId: userId,
        ownerTag: updatedConversation.sharedByTag,
        conversation: updatedConversation,
        sharedAt,
        sharedByUserId: updatedConversation.sharedByUserId ?? userId,
        sharedByTag: updatedConversation.sharedByTag,
      }),
    );
  }

  return {
    conversationId: conversation.id,
    answer: renderedAnswer,
    sourceMeetingIds,
    conversation: updatedConversation,
    messages: [
      renderMessageForDisplay({
        message: userMessage,
        guildId,
        portalBaseUrl,
      }),
      renderMessageForDisplay({
        message: replyMessage,
        guildId,
        portalBaseUrl,
      }),
    ],
  };
}

/** Project an authoritative completed run. Retrying this does not run the agent. */
export async function persistCompletedAskRun(params: {
  userId: string;
  guildId: string;
  conversationId: string;
  requestId: string;
  question: string;
  createdAt: string;
  completedAt: string;
  result: {
    answer: string;
    citations?: import("../types/ask").AskCitation[];
    sourceMeetingIds?: string[];
  };
}) {
  const { userId, guildId, conversationId, requestId, result } = params;
  const repo = getAskConversationRepository();
  const existing = await repo.getConversation(userId, guildId, conversationId);
  const conversation: AskConversation = {
    ...(existing ?? buildConversation(userId, guildId, conversationId)),
    createdAt: existing?.createdAt ?? params.createdAt,
    updatedAt: params.completedAt,
    title:
      !existing || existing.title === DEFAULT_TITLE
        ? truncate(params.question, 80)
        : existing.title,
    summary: summarize(stripCitationTags(result.answer)),
  };
  const messages: AskMessage[] = [
    {
      id: `${requestId}:user`,
      role: "user",
      text: params.question,
      createdAt: params.createdAt,
    },
    {
      id: `${requestId}:answer`,
      role: "chronote",
      text: result.answer,
      createdAt: params.completedAt,
      citations: result.citations ?? [],
      sourceMeetingIds: result.sourceMeetingIds ?? [],
    },
  ];
  for (const message of messages)
    await repo.writeMessage(userId, guildId, conversationId, message);
  await repo.writeCompletedConversation(userId, guildId, conversation);
  const current =
    (await repo.getConversation(userId, guildId, conversationId)) ??
    conversation;
  if (
    isSharedVisibility(current.visibility) &&
    current.updatedAt === params.completedAt
  ) {
    await repo.writeCompletedShare(
      buildShareRecord({
        guildId,
        ownerUserId: userId,
        ownerTag: current.sharedByTag,
        conversation: current,
        sharedAt: current.sharedAt ?? params.completedAt,
        sharedByUserId: current.sharedByUserId ?? userId,
        sharedByTag: current.sharedByTag,
      }),
    );
  }
  return {
    conversationId,
    conversation: current,
    answer: renderAskAnswer({
      text: result.answer,
      citations: result.citations ?? [],
      guildId,
      portalBaseUrl: resolvePortalBaseUrl(),
    }),
    sourceMeetingIds: result.sourceMeetingIds ?? [],
    messages: messages.map((message) =>
      renderMessageForDisplay({
        message,
        guildId,
        portalBaseUrl: resolvePortalBaseUrl(),
      }),
    ),
  };
}
