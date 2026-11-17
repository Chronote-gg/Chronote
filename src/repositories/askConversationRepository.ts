import {
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { config } from "../services/configService";
import {
  getAskConversation,
  listAskConversations,
  listAskMessages,
  listAskConversationShares,
  getAskConversationShare,
  writeAskConversation,
  writeAskMessage,
  writeAskConversationShare,
  deleteAskConversationShare,
} from "../db";
import type {
  AskConversation,
  AskMessage,
  AskSharedConversation,
} from "../types/ask";
import type {
  AskConversationRecord,
  AskMessageRecord,
  AskConversationShareRecord,
} from "../types/db";
import { getMockStore } from "./mockStore";

const buildPartitionKey = (userId: string, guildId: string) =>
  `USER#${userId}#GUILD#${guildId}`;

const toConversation = (record: AskConversationRecord): AskConversation => ({
  id: record.conversationId,
  title: record.title,
  summary: record.summary,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  visibility: record.visibility,
  sharedAt: record.sharedAt,
  sharedByUserId: record.sharedByUserId,
  sharedByTag: record.sharedByTag,
  archivedAt: record.archivedAt,
  archivedByUserId: record.archivedByUserId,
});

const toMessage = (record: AskMessageRecord): AskMessage => ({
  id: record.messageId,
  role: record.role,
  text: record.text,
  createdAt: record.createdAt,
  sourceMeetingIds: record.sourceMeetingIds,
  citations: record.citations,
});

const toSharedConversation = (
  record: AskConversationShareRecord,
): AskSharedConversation => ({
  conversationId: record.conversationId,
  title: record.title,
  summary: record.summary,
  updatedAt: record.updatedAt,
  sharedAt: record.sharedAt,
  ownerUserId: record.ownerUserId,
  ownerTag: record.ownerTag,
  archivedAt: record.archivedAt,
});

export type AskConversationRepository = {
  writeCompletedShare(record: AskConversationShareRecord): Promise<void>;
  writeCompletedConversation(
    userId: string,
    guildId: string,
    conversation: AskConversation,
  ): Promise<void>;
  listConversations: (
    userId: string,
    guildId: string,
  ) => Promise<AskConversation[]>;
  listSharedConversations: (
    guildId: string,
  ) => Promise<AskSharedConversation[]>;
  getConversation: (
    userId: string,
    guildId: string,
    conversationId: string,
  ) => Promise<AskConversation | undefined>;
  getSharedConversation: (
    guildId: string,
    conversationId: string,
  ) => Promise<AskSharedConversation | undefined>;
  listMessages: (
    userId: string,
    guildId: string,
    conversationId: string,
  ) => Promise<AskMessage[]>;
  writeConversation: (
    userId: string,
    guildId: string,
    conversation: AskConversation,
  ) => Promise<void>;
  writeMessage: (
    userId: string,
    guildId: string,
    conversationId: string,
    message: AskMessage,
  ) => Promise<void>;
  writeSharedConversation: (
    record: AskConversationShareRecord,
  ) => Promise<void>;
  deleteSharedConversation: (
    guildId: string,
    conversationId: string,
  ) => Promise<void>;
};

const realRepository: AskConversationRepository = {
  async writeCompletedShare(record) {
    try {
      await dynamoDbClient.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: tableName("AskConversationTable"),
                Key: marshall({
                  pk: buildPartitionKey(record.ownerUserId, record.guildId),
                  sk: `CONV#${record.conversationId}`,
                }),
                ConditionExpression:
                  "updatedAt = :completed AND (#visibility = :server OR #visibility = :public)",
                ExpressionAttributeNames: { "#visibility": "visibility" },
                ExpressionAttributeValues: marshall({
                  ":completed": record.updatedAt,
                  ":server": "server",
                  ":public": "public",
                }),
              },
            },
            {
              Put: {
                TableName: tableName("AskConversationTable"),
                Item: marshall(record, { removeUndefinedValues: true }),
                ConditionExpression:
                  "attribute_not_exists(updatedAt) OR updatedAt <= :completed",
                ExpressionAttributeValues: marshall({
                  ":completed": record.updatedAt,
                }),
              },
            },
          ],
        }),
      );
    } catch (error) {
      const failure = error as {
        name?: string;
        CancellationReasons?: { Code?: string }[];
      };
      if (
        failure.name !== "TransactionCanceledException" ||
        !failure.CancellationReasons?.some(
          (reason) => reason.Code === "ConditionalCheckFailed",
        )
      )
        throw error;
    }
  },
  async writeCompletedConversation(userId, guildId, conversation) {
    try {
      await dynamoDbClient.send(
        new UpdateItemCommand({
          TableName: tableName("AskConversationTable"),
          Key: marshall({
            pk: buildPartitionKey(userId, guildId),
            sk: `CONV#${conversation.id}`,
          }),
          // Completion owns answer metadata, never sharing or archive decisions.
          UpdateExpression:
            "SET #title = if_not_exists(#title, :title), summary = :summary, updatedAt = :completed, createdAt = if_not_exists(createdAt, :created), #type = if_not_exists(#type, :type), conversationId = if_not_exists(conversationId, :id), guildId = if_not_exists(guildId, :guild), userId = if_not_exists(userId, :user), #visibility = if_not_exists(#visibility, :private)",
          ConditionExpression:
            "attribute_not_exists(updatedAt) OR updatedAt <= :completed",
          ExpressionAttributeNames: {
            "#title": "title",
            "#type": "type",
            "#visibility": "visibility",
          },
          ExpressionAttributeValues: marshall({
            ":title": conversation.title,
            ":summary": conversation.summary,
            ":completed": conversation.updatedAt,
            ":created": conversation.createdAt,
            ":type": "conversation",
            ":id": conversation.id,
            ":guild": guildId,
            ":user": userId,
            ":private": "private",
          }),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
    }
  },
  async listConversations(userId, guildId) {
    const records = await listAskConversations(userId, guildId);
    return records.map(toConversation);
  },
  async listSharedConversations(guildId) {
    const records = await listAskConversationShares(guildId);
    return records.map(toSharedConversation);
  },
  async getConversation(userId, guildId, conversationId) {
    const record = await getAskConversation(userId, guildId, conversationId);
    return record ? toConversation(record) : undefined;
  },
  async getSharedConversation(guildId, conversationId) {
    const record = await getAskConversationShare(guildId, conversationId);
    return record ? toSharedConversation(record) : undefined;
  },
  async listMessages(userId, guildId, conversationId) {
    const records = await listAskMessages(userId, guildId, conversationId);
    return records.map(toMessage);
  },
  async writeConversation(userId, guildId, conversation) {
    const record: AskConversationRecord = {
      pk: buildPartitionKey(userId, guildId),
      sk: `CONV#${conversation.id}`,
      type: "conversation",
      conversationId: conversation.id,
      guildId,
      userId,
      title: conversation.title,
      summary: conversation.summary,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      visibility: conversation.visibility,
      sharedAt: conversation.sharedAt,
      sharedByUserId: conversation.sharedByUserId,
      sharedByTag: conversation.sharedByTag,
      archivedAt: conversation.archivedAt,
      archivedByUserId: conversation.archivedByUserId,
    };
    await writeAskConversation(record);
  },
  async writeMessage(userId, guildId, conversationId, message) {
    const record: AskMessageRecord = {
      pk: buildPartitionKey(userId, guildId),
      sk: `MSG#${conversationId}#${message.createdAt}#${message.id}`,
      type: "message",
      conversationId,
      messageId: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      sourceMeetingIds: message.sourceMeetingIds,
      citations: message.citations,
    };
    await writeAskMessage(record);
  },
  async writeSharedConversation(record) {
    await writeAskConversationShare(record);
  },
  async deleteSharedConversation(guildId, conversationId) {
    await deleteAskConversationShare(guildId, conversationId);
  },
};

const mockRepository: AskConversationRepository = {
  async writeCompletedShare(record) {
    const canonical = getMockStore()
      .askConversationsByKey.get(
        buildPartitionKey(record.ownerUserId, record.guildId),
      )
      ?.find((item) => item.id === record.conversationId);
    if (
      !canonical ||
      canonical.updatedAt !== record.updatedAt ||
      (canonical.visibility !== "server" && canonical.visibility !== "public")
    )
      return;
    const current = getMockStore()
      .askSharesByGuild.get(record.guildId)
      ?.find((item) => item.conversationId === record.conversationId);
    if (!current || current.updatedAt <= record.updatedAt)
      await mockRepository.writeSharedConversation(record);
  },
  async writeCompletedConversation(userId, guildId, conversation) {
    const current = getMockStore()
      .askConversationsByKey.get(buildPartitionKey(userId, guildId))
      ?.find((item) => item.id === conversation.id);
    if (!current || current.updatedAt <= conversation.updatedAt)
      await mockRepository.writeConversation(
        userId,
        guildId,
        current
          ? {
              ...current,
              summary: conversation.summary,
              updatedAt: conversation.updatedAt,
            }
          : { ...conversation, visibility: "private" },
      );
  },
  async listConversations(userId, guildId) {
    const key = buildPartitionKey(userId, guildId);
    return getMockStore().askConversationsByKey.get(key) ?? [];
  },
  async listSharedConversations(guildId) {
    return getMockStore().askSharesByGuild.get(guildId) ?? [];
  },
  async getConversation(userId, guildId, conversationId) {
    const key = buildPartitionKey(userId, guildId);
    const conversations = getMockStore().askConversationsByKey.get(key) ?? [];
    return conversations.find((conv) => conv.id === conversationId);
  },
  async getSharedConversation(guildId, conversationId) {
    const shares = getMockStore().askSharesByGuild.get(guildId) ?? [];
    return shares.find((conv) => conv.conversationId === conversationId);
  },
  async listMessages(userId, guildId, conversationId) {
    const key = `${buildPartitionKey(userId, guildId)}#${conversationId}`;
    return getMockStore().askMessagesByConversation.get(key) ?? [];
  },
  async writeConversation(userId, guildId, conversation) {
    const store = getMockStore();
    const key = buildPartitionKey(userId, guildId);
    const conversations = store.askConversationsByKey.get(key) ?? [];
    const updated = conversations.filter((item) => item.id !== conversation.id);
    updated.unshift(conversation);
    store.askConversationsByKey.set(key, updated);
  },
  async writeMessage(userId, guildId, conversationId, message) {
    const store = getMockStore();
    const key = `${buildPartitionKey(userId, guildId)}#${conversationId}`;
    const messages = store.askMessagesByConversation.get(key) ?? [];
    const existing = messages.findIndex(
      (item) => item.id === message.id && item.role === message.role,
    );
    if (existing >= 0) messages[existing] = message;
    else messages.push(message);
    store.askMessagesByConversation.set(key, messages);
  },
  async writeSharedConversation(record) {
    const store = getMockStore();
    const shares = store.askSharesByGuild.get(record.guildId) ?? [];
    const updated = shares.filter(
      (item) => item.conversationId !== record.conversationId,
    );
    updated.unshift(toSharedConversation(record));
    store.askSharesByGuild.set(record.guildId, updated);
  },
  async deleteSharedConversation(guildId, conversationId) {
    const store = getMockStore();
    const shares = store.askSharesByGuild.get(guildId) ?? [];
    store.askSharesByGuild.set(
      guildId,
      shares.filter((item) => item.conversationId !== conversationId),
    );
  },
};

export function getAskConversationRepository(): AskConversationRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
