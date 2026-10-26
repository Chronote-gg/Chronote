import type { ExpectedIntroOffer } from "../types/pricing";

export function resolvePurchaseOffer(value?: string): ExpectedIntroOffer {
  return value === "basic_intro_v1" || value === "basic_annual_intro_v1"
    ? value
    : "none";
}

export const PURCHASE_SOURCES = [
  "homepage_pricing",
  "discord_summary",
  "discord_notes",
  "discord_limit",
  "portal_billing",
  "direct",
  "unknown",
] as const;

export type PurchaseSource = (typeof PURCHASE_SOURCES)[number];

export function resolvePurchaseSource(value?: string): PurchaseSource {
  if (value === undefined) return "direct";
  return PURCHASE_SOURCES.find((source) => source === value) ?? "unknown";
}

export function resolveAnalyticsEnvironment(origin: string) {
  const hostname = new URL(origin).hostname;
  if (hostname === "chronote.gg" || hostname === "www.chronote.gg")
    return "production";
  if (hostname === "sandbox.chronote.gg") return "sandbox";
  if (hostname === "localhost" || hostname === "127.0.0.1") return "local";
  // Preview/custom hosts must not silently enter production reports.
  return "unknown";
}

export const RECORDING_LIMIT_TYPES = [
  "weekly_recording",
  "meeting_duration",
] as const;
export const RECORDING_LIMIT_SURFACES = [
  "manual_start",
  "auto_start",
  "duration_stop",
  "weekly_after_meeting",
  "weekly_warning",
  "mcp_start",
] as const;
export type RecordingLimitContext =
  | { limitType: "meeting_duration"; limitSurface: "duration_stop" }
  | {
      limitType: "weekly_recording";
      limitSurface: Exclude<
        (typeof RECORDING_LIMIT_SURFACES)[number],
        "duration_stop"
      >;
    };

type LimitContextInput = { limitType?: string; limitSurface?: string };
export function resolveRecordingLimitContext(
  input: LimitContextInput,
): RecordingLimitContext | undefined {
  if (
    input.limitType === "meeting_duration" &&
    input.limitSurface === "duration_stop"
  )
    return { limitType: "meeting_duration", limitSurface: "duration_stop" };
  if (input.limitType !== "weekly_recording") return undefined;
  const surface = RECORDING_LIMIT_SURFACES.find(
    (value) => value === input.limitSurface,
  );
  if (!surface || surface === "duration_stop") return undefined;
  return { limitType: "weekly_recording", limitSurface: surface };
}
export function recordingLimitAnalytics(input: LimitContextInput) {
  const context = resolveRecordingLimitContext(input);
  return context
    ? { limit_type: context.limitType, limit_surface: context.limitSurface }
    : {};
}
