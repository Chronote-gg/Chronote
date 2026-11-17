import type { AskCitation } from "./ask";

export type AskRunStatus =
  "queued" | "running" | "completed" | "stopped" | "interrupted" | "failed";
export type AskRunScope = {
  userId: string;
  guildId: string;
  conversationId: string;
};
export type AskRunInput = AskRunScope & {
  requestId: string;
  question: string;
  contextMeetingIds?: string[];
  timezone?: string;
};
export type AskRunResult = {
  answer: string;
  citations?: AskCitation[];
  [key: string]: unknown;
};
export type AskRunSnapshot = {
  runId: string;
  requestId: string;
  conversationId: string;
  question: string;
  status: AskRunStatus;
  text: string;
  activity?: string;
  result?: AskRunResult;
  createdAt: string;
  updatedAt: string;
};
export type AskRunRecord = {
  input: AskRunInput;
  snapshot: AskRunSnapshot;
  ownerToken: string;
  version: number;
  leaseExpiresAt: number;
  privateState?: unknown;
};
export const isAskRunActive = (status: AskRunStatus) =>
  status === "queued" || status === "running";
