import { Participant } from "./participants";

export type ChatEntryType = "message" | "join" | "leave";
export type ChatEntrySource = "chat" | "chat_tts";

export type ChatAttachment = {
  id: string;
  name: string;
  size: number;
  url: string;
  proxyUrl?: string;
  contentType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  description?: string;
  ephemeral?: boolean;
};

export interface ChatEntry {
  type: ChatEntryType;
  source?: ChatEntrySource;
  user: Participant;
  channelId: string;
  content?: string;
  attachments?: ChatAttachment[];
  messageId?: string;
  timestamp: string; // ISO string
}
