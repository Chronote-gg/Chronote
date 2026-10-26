import type { MeetingHistory } from "../types/db";
import type { PreparedMeetingUpdateAttempt } from "../types/meetingUpdateDelivery";
import type {
  DiscordChannel,
  DiscordEditorMessage,
} from "./discordMessageEditor";

export type MeetingUpdatePlanInput = {
  history: MeetingHistory;
  attemptId: string;
  observedAt: number;
  botId: string;
  channels: DiscordChannel[];
  messages: DiscordEditorMessage[];
};
export type MeetingUpdatePayload = {
  kind: "patch" | "post";
  operationId: string;
  payload: {
    embeds: Record<string, unknown>[];
    allowed_mentions: { parse: [] };
  };
};
export type MeetingUpdateTarget = {
  channelId: string;
  messageId: string;
  beforeFingerprint: string;
  desiredFingerprint: string;
  after: DiscordEditorMessage;
};
export type MeetingUpdatePlan =
  | {
      kind: "ready";
      attempt: PreparedMeetingUpdateAttempt;
      targets: MeetingUpdateTarget[];
      payloads: MeetingUpdatePayload[];
    }
  | { kind: "blocked"; reason: string }
  | { kind: "idle" };

export class MeetingUpdatePlanBlocked extends Error {}
