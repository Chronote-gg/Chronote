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

export type NotionAutomationConfig = {
  guildId: string;
  ownerUserId: string;
  workspaceId: string;
  workspaceName?: string;
  destinationType: "page";
  destinationPageId: string;
  destinationTitle?: string;
  destinationUrl?: string;
  autoExportEnabled: boolean;
  channelIds?: string[];
  tags?: string[];
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotionAutomationExportStatus = "exported" | "failed";

export type NotionAutomationMeetingExport = {
  guildId: string;
  channelId_timestamp: string;
  ownerUserId: string;
  notionPageId?: string;
  notionPageUrl?: string;
  notionWorkspaceId?: string;
  exportedNotesVersion: number;
  status: NotionAutomationExportStatus;
  attemptCount: number;
  lastAttemptAt: string;
  lastExportedAt?: string;
  lastError?: string;
};

export type NotionMeetingExport = {
  userId: string;
  guildId: string;
  channelId_timestamp: string;
  notionPageId: string;
  notionPageUrl: string;
  notionWorkspaceId: string;
  exportedNotesVersion: number;
  lastExportedAt: string;
  lastError?: string;
};

export type NotionDestinationPage = {
  id: string;
  title: string;
  url?: string;
};

export type NotionExportStatus = {
  exported: boolean;
  source?: "manual" | "automation";
  pageUrl?: string;
  pageId?: string;
  exportedNotesVersion?: number;
  currentNotesVersion: number;
  outdated: boolean;
  lastExportedAt?: string;
  lastError?: string;
};

export type NotionAutomationStatus = {
  configured: boolean;
  userConnected: boolean;
  workspaceName?: string;
  workspaceId?: string;
  automation?: {
    enabled: boolean;
    ownerUserId: string;
    ownerConnected: boolean;
    workspaceName?: string;
    workspaceId: string;
    destinationType: "page";
    destinationPageId: string;
    destinationTitle?: string;
    destinationUrl?: string;
    channelIds: string[];
    tags: string[];
    lastError?: string;
    updatedAt: string;
  };
};
