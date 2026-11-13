import type { MeetingUpdateDeliveryRepository } from "../repositories/meetingUpdateDeliveryRepository";
import type {
  MeetingUpdateKey,
  MeetingUpdateDelivery,
  MeetingUpdateProgress,
} from "../types/meetingUpdateDelivery";
import type { MeetingHistory } from "../types/db";
import type { createDiscordMeetingUpdateTransport } from "./discordMeetingUpdateTransport";
export type MeetingDeliveryRunInput = {
  key: MeetingUpdateKey;
  signal?: AbortSignal;
};
export type MeetingDeliveryClaim = {
  claimId: string;
  instanceId: string;
  expiresAt: number;
};
export type MeetingDeliveryObservation = {
  operationId: string;
  kind: "desired" | "before" | "different" | "missing" | "unavailable";
};
type Outcome = {
  observations?: MeetingDeliveryObservation[];
  capturedRevision: number | null;
};
export type MeetingDeliveryRunResult =
  | (Outcome & { kind: "settled" })
  | (Outcome & { kind: "retryable"; retryAt: number })
  | (Outcome & { kind: "blocked"; reason: string })
  | (Outcome & { kind: "uncertain" })
  | (Outcome & { kind: "superseded" });
export type MeetingDeliveryDependencies = {
  repository: MeetingUpdateDeliveryRepository;
  discord: ReturnType<typeof createDiscordMeetingUpdateTransport>;
  now?: () => number;
  random?: () => number;
  requestTimeoutMs?: number;
  renewalIntervalMs?: number;
};
export type DeliveryHistory = MeetingHistory & {
  updateDelivery: MeetingUpdateDelivery;
};
export type DeliveryAttemptProgress = Extract<
  MeetingUpdateProgress,
  { kind: "running" | "reconciling" | "uncertain" }
>;
export const MAX_CONSECUTIVE_KNOWN_FAILURES = 8;
export const MEETING_UPDATE_REQUEST_TIMEOUT_MS = 10000;
export class MeetingDeliveryStopped extends Error {}
