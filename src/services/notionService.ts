import { z } from "zod";
import { config } from "./configService";
import { decryptToken, encryptToken } from "./tokenEncryptionService";
import {
  getNotionIntegrationRepository,
  type NotionIntegrationRepository,
} from "../repositories/notionIntegrationRepository";
import type { MeetingHistory } from "../types/db";
import type {
  NotionConnection,
  NotionExportStatus,
  NotionMeetingExport,
} from "../types/notionIntegration";

const NOTION_API_ORIGIN = "https://api.notion.com";
const NOTION_AUTHORIZE_URL = `${NOTION_API_ORIGIN}/v1/oauth/authorize`;
const NOTION_TOKEN_URL = `${NOTION_API_ORIGIN}/v1/oauth/token`;
const NOTION_TEXT_ESCAPE = /([\\*~`$[\]<>{}|^])/g;

type NotionFetch = typeof fetch;

let notionFetch: NotionFetch = (...args) => fetch(...args);

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

const notionOwnerSchema = z.object({
  type: z.string(),
});

const notionTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  bot_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string().nullable().optional(),
  workspace_icon: z.string().nullable().optional(),
  owner: notionOwnerSchema.optional(),
});

const notionPageResponseSchema = z.object({
  id: z.string(),
  url: z.string().url(),
});

const notionMarkdownResponseSchema = z.object({
  markdown: z.string(),
});

const notionErrorResponseSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

const getRepository = (repository?: NotionIntegrationRepository) =>
  repository ?? getNotionIntegrationRepository();

const buildBasicAuthHeader = () =>
  `Basic ${Buffer.from(
    `${config.notion.clientId}:${config.notion.clientSecret}`,
  ).toString("base64")}`;

const postNotionToken = async (body: Record<string, string>) => {
  const response = await notionFetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: buildBasicAuthHeader(),
      "Content-Type": "application/json",
      "Notion-Version": config.notion.apiVersion,
    },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = notionErrorResponseSchema.safeParse(payload);
    throw new NotionApiError(
      response.status,
      parsed.success ? (parsed.data.code ?? "notion_error") : "notion_error",
      parsed.success
        ? (parsed.data.message ?? "Notion request failed.")
        : "Notion request failed.",
    );
  }
  return notionTokenResponseSchema.parse(payload);
};

const requestNotionApi = async <T>(params: {
  accessToken: string;
  path: string;
  method: "GET" | "POST" | "PATCH";
  body?: unknown;
  schema: z.ZodType<T>;
}): Promise<T> => {
  const response = await notionFetch(`${NOTION_API_ORIGIN}${params.path}`, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": config.notion.apiVersion,
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = notionErrorResponseSchema.safeParse(payload);
    throw new NotionApiError(
      response.status,
      parsed.success ? (parsed.data.code ?? "notion_error") : "notion_error",
      parsed.success
        ? (parsed.data.message ?? "Notion request failed.")
        : "Notion request failed.",
    );
  }
  return params.schema.parse(payload);
};

const refreshConnection = async (
  connection: NotionConnection,
  repository: NotionIntegrationRepository,
) => {
  if (!connection.encryptedRefreshToken) {
    throw new NotionApiError(401, "missing_refresh_token", "Reconnect Notion.");
  }
  const refreshed = await postNotionToken({
    grant_type: "refresh_token",
    refresh_token: decryptToken(connection.encryptedRefreshToken),
  });
  const updated: NotionConnection = {
    ...connection,
    encryptedAccessToken: encryptToken(refreshed.access_token),
    encryptedRefreshToken: refreshed.refresh_token
      ? encryptToken(refreshed.refresh_token)
      : connection.encryptedRefreshToken,
    workspaceId: refreshed.workspace_id,
    workspaceName: refreshed.workspace_name ?? undefined,
    workspaceIcon: refreshed.workspace_icon ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  await repository.writeConnection(updated);
  return updated;
};

const withNotionToken = async <T>(params: {
  userId: string;
  repository?: NotionIntegrationRepository;
  action: (accessToken: string, connection: NotionConnection) => Promise<T>;
}) => {
  const repository = getRepository(params.repository);
  const connection = await repository.getConnection(params.userId);
  if (!connection) {
    throw new NotionApiError(401, "not_connected", "Connect Notion first.");
  }

  try {
    return await params.action(
      decryptToken(connection.encryptedAccessToken),
      connection,
    );
  } catch (err) {
    if (!(err instanceof NotionApiError) || err.status !== 401) throw err;
    const refreshed = await refreshConnection(connection, repository);
    return params.action(
      decryptToken(refreshed.encryptedAccessToken),
      refreshed,
    );
  }
};

const escapeNotionText = (value: string) =>
  value.replace(NOTION_TEXT_ESCAPE, "\\$1");

const trimHeading = (value: string | undefined) => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? escapeNotionText(trimmed) : "Meeting notes";
};

const formatDuration = (seconds: number) => {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

const formatParticipantNames = (meeting: MeetingHistory) =>
  meeting.participants
    .map(
      (participant) =>
        participant.serverNickname ??
        participant.displayName ??
        participant.username ??
        participant.tag,
    )
    .filter((name): name is string => Boolean(name))
    .map(escapeNotionText)
    .join(", ");

export const buildNotionAuthorizationUrl = (state: string) => {
  const params = new URLSearchParams({
    owner: "user",
    client_id: config.notion.clientId,
    redirect_uri: config.notion.redirectUri,
    response_type: "code",
    state,
  });
  return `${NOTION_AUTHORIZE_URL}?${params.toString()}`;
};

export const buildMeetingNotionMarkdown = (meeting: MeetingHistory) => {
  const notes = meeting.notes?.trim() || "No Chronote notes are available yet.";
  const title = trimHeading(
    meeting.meetingName ?? meeting.summaryLabel ?? meeting.summarySentence,
  );
  const participants = formatParticipantNames(meeting);
  const details = [
    `- Date: ${escapeNotionText(new Date(meeting.timestamp).toISOString())}`,
    `- Duration: ${escapeNotionText(formatDuration(meeting.duration))}`,
    `- Discord channel: ${escapeNotionText(meeting.channelId)}`,
    participants ? `- Participants: ${participants}` : undefined,
    meeting.notesVersion
      ? `- Chronote notes version: v${meeting.notesVersion}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return [
    `# ${title}`,
    "",
    "> Exported from Chronote. Use Sync latest notes in Chronote to refresh this page.",
    "",
    "## Details",
    "",
    ...details,
    "",
    "## Notes",
    "",
    notes,
  ].join("\n");
};

export const getNotionStatus = async (userId: string) => {
  const connection =
    await getNotionIntegrationRepository().getConnection(userId);
  return {
    configured: config.notion.enabled,
    connected: Boolean(connection),
    workspaceName: connection?.workspaceName,
    workspaceId: connection?.workspaceId,
  };
};

export const saveNotionConnectionFromCode = async (params: {
  userId: string;
  code: string;
  repository?: NotionIntegrationRepository;
}) => {
  const token = await postNotionToken({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.notion.redirectUri,
  });
  const now = new Date().toISOString();
  const repository = getRepository(params.repository);
  const existing = await repository.getConnection(params.userId);
  const connection: NotionConnection = {
    userId: params.userId,
    botId: token.bot_id,
    workspaceId: token.workspace_id,
    workspaceName: token.workspace_name ?? undefined,
    workspaceIcon: token.workspace_icon ?? undefined,
    encryptedAccessToken: encryptToken(token.access_token),
    encryptedRefreshToken: token.refresh_token
      ? encryptToken(token.refresh_token)
      : existing?.encryptedRefreshToken,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await repository.writeConnection(connection);
  return connection;
};

export const getMeetingNotionExportStatus = async (params: {
  userId: string;
  guildId: string;
  meetingId: string;
  currentNotesVersion: number;
}): Promise<NotionExportStatus> => {
  const existing =
    await getNotionIntegrationRepository().getMeetingExport(params);
  if (!existing) {
    return {
      exported: false,
      currentNotesVersion: params.currentNotesVersion,
      outdated: false,
    };
  }
  return {
    exported: true,
    pageUrl: existing.notionPageUrl,
    pageId: existing.notionPageId,
    exportedNotesVersion: existing.exportedNotesVersion,
    currentNotesVersion: params.currentNotesVersion,
    outdated: existing.exportedNotesVersion < params.currentNotesVersion,
    lastExportedAt: existing.lastExportedAt,
    lastError: existing.lastError,
  };
};

export const exportMeetingToNotion = async (params: {
  userId: string;
  meeting: MeetingHistory;
  repository?: NotionIntegrationRepository;
}) => {
  const repository = getRepository(params.repository);
  const existing = await repository.getMeetingExport({
    userId: params.userId,
    guildId: params.meeting.guildId,
    meetingId: params.meeting.channelId_timestamp,
  });
  if (existing) {
    throw new NotionApiError(
      400,
      "already_exported",
      "Meeting already exported to Notion. Sync it instead.",
    );
  }

  return withNotionToken({
    userId: params.userId,
    repository,
    async action(accessToken, connection) {
      const markdown = buildMeetingNotionMarkdown(params.meeting);
      const page = await requestNotionApi({
        accessToken,
        method: "POST",
        path: "/v1/pages",
        body: {
          parent: { type: "workspace", workspace: true },
          markdown,
        },
        schema: notionPageResponseSchema,
      });
      const now = new Date().toISOString();
      const meetingExport: NotionMeetingExport = {
        userId: params.userId,
        guildId: params.meeting.guildId,
        channelId_timestamp: params.meeting.channelId_timestamp,
        notionPageId: page.id,
        notionPageUrl: page.url,
        notionWorkspaceId: connection.workspaceId,
        exportedNotesVersion: params.meeting.notesVersion ?? 1,
        lastExportedAt: now,
      };
      await repository.writeMeetingExport(meetingExport);
      return meetingExport;
    },
  });
};

export const syncMeetingToNotion = async (params: {
  userId: string;
  meeting: MeetingHistory;
  repository?: NotionIntegrationRepository;
}) => {
  const repository = getRepository(params.repository);
  const existing = await repository.getMeetingExport({
    userId: params.userId,
    guildId: params.meeting.guildId,
    meetingId: params.meeting.channelId_timestamp,
  });
  if (!existing) {
    throw new NotionApiError(404, "not_exported", "Export to Notion first.");
  }

  return withNotionToken({
    userId: params.userId,
    repository,
    async action(accessToken) {
      const markdown = buildMeetingNotionMarkdown(params.meeting);
      await requestNotionApi({
        accessToken,
        method: "PATCH",
        path: `/v1/pages/${existing.notionPageId}/markdown`,
        body: {
          type: "replace_content",
          replace_content: { new_str: markdown },
        },
        schema: notionMarkdownResponseSchema,
      });
      const updated: NotionMeetingExport = {
        ...existing,
        exportedNotesVersion: params.meeting.notesVersion ?? 1,
        lastExportedAt: new Date().toISOString(),
        lastError: undefined,
      };
      await repository.writeMeetingExport(updated);
      return updated;
    },
  });
};

export const setNotionFetchForTests = (nextFetch: NotionFetch) => {
  notionFetch = nextFetch;
};

export const resetNotionFetchForTests = () => {
  notionFetch = (...args) => fetch(...args);
};
