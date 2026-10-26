import type { MeetingUpdateDeliveryRepository } from "../repositories/meetingUpdateDeliveryRepository";
import type {
  MeetingUpdateKey,
  MeetingUpdateDelivery,
  MeetingUpdateProgress,
} from "../types/meetingUpdateDelivery";
import type { MeetingHistory } from "../types/db";
import type { RuntimeWorkClaim } from "./runtimeWorkAdmissionService";
import type { createDiscordMeetingUpdateTransport } from "./discordMeetingUpdateTransport";
export type MeetingDeliveryRunInput = {
  key: MeetingUpdateKey;
  work: RuntimeWorkClaim;
  signal?: AbortSignal;
};
export type MeetingDeliveryClaim = Parameters<
  RuntimeWorkClaim["recordClaim"]
>[0];
export type MeetingDeliveryDurableOutcome = {
  deliveryRevision: string;
  claim: MeetingDeliveryClaim | null;
};
export type MeetingDeliveryObservation = {
  operationId: string;
  kind: "desired" | "before" | "different" | "missing" | "unavailable";
};
type Outcome = {
  observations?: MeetingDeliveryObservation[];
  noClaim?: { kind: "never_admitted" };
  capturedRevision: number | null;
  durable?: MeetingDeliveryDurableOutcome;
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
