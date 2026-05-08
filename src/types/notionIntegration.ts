export type NotionConnection = {
  userId: string;
  botId: string;
  workspaceId: string;
  workspaceName?: string;
  workspaceIcon?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotionMeetingExport = {
  userId: string;
  guildId: string;
  meetingId: string;
  notionPageId: string;
  notionPageUrl: string;
  notionWorkspaceId: string;
  exportedNotesVersion: number;
  lastExportedAt: string;
  lastError?: string;
};

export type NotionExportStatus = {
  exported: boolean;
  pageUrl?: string;
  pageId?: string;
  exportedNotesVersion?: number;
  currentNotesVersion?: number;
  outdated: boolean;
  lastExportedAt?: string;
  lastError?: string;
};
