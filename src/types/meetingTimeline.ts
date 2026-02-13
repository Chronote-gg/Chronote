import type { ChatAttachment } from "./chat";

export type MeetingEventType = "voice" | "chat" | "tts" | "presence" | "bot";

export type MeetingEvent = {
  id: string;
  type: MeetingEventType;
  time: string;
  speaker?: string;
  text: string;
  messageId?: string;
  attachments?: ChatAttachment[];
};
