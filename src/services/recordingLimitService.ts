import type { MeetingData } from "../types/meeting-data";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
  runMeetingNoticeMutation,
} from "./meetingProcessingLifetime";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { config } from "./configService";
import { getGuildLimits, getLimitsForTier } from "./subscriptionService";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { tryCreateInteractionReceipt, releaseInteractionReceipt } from "../db";
import { captureEvent } from "./analyticsService";
import {
  recordingLimitAnalytics,
  type RecordingLimitContext,
} from "../utils/purchaseAnalytics";
import type { PaidTier } from "../types/pricing";
import type { InteractionReceipt } from "../types/db";

type ResolvedLimits = Awaited<ReturnType<typeof getGuildLimits>>;
export type RecordingLimitInput = RecordingLimitContext & {
  guildId: string;
  userId?: string;
  outcome:
    | "blocked_start"
    | "ended_session"
    | "exhausted_after_meeting"
    | "near_limit";
  limitMinutes: number;
  usedMinutes?: number;
  message: string;
  resolved?: ResolvedLimits;
};
type LimitAction = {
  kind: "upgrade" | "manage_billing" | "open_meetings";
  label: string;
  url: string;
  purchasePath:
    "initial_purchase" | "existing_billing" | "no_purchase" | "unknown";
  eligibility:
    | "higher_allowance"
    | "existing_billing"
    | "no_higher_limit"
    | "already_available"
    | "forced"
    | "billing_unavailable"
    | "lookup_unavailable";
  targetTier?: PaidTier;
  benefit: string;
};
export type RecordingLimitNotice = {
  input: RecordingLimitInput;
  action: LimitAction;
  currentTier?: ResolvedLimits["subscription"]["tier"];
  payload: Pick<MessageCreateOptions, "components" | "allowedMentions"> & {
    content: string;
  };
};
type NoticeMessage = {
  edit: (payload: MessageEditOptions) => Promise<unknown>;
};
export type RecordingLimitState = {
  message?: NoticeMessage;
  pending?: Promise<NoticeMessage | undefined>;
  durationContent?: string;
  deliveryUnknown?: boolean;
};
type NoticeChannel = {
  send: (payload: MessageCreateOptions) => Promise<NoticeMessage>;
};

function contextUrl(input: RecordingLimitInput, path: string) {
  const url = new URL(path, config.frontend.siteUrl);
  url.searchParams.set("source", "discord_limit");
  url.searchParams.set("limitType", input.limitType);
  url.searchParams.set("limitSurface", input.limitSurface);
  return url;
}
function neutralAction(
  input: RecordingLimitInput,
  eligibility: LimitAction["eligibility"],
  benefit = "",
): LimitAction {
  return {
    kind: "open_meetings",
    label: "Open meetings",
    url: new URL(
      `/portal/server/${encodeURIComponent(input.guildId)}/library`,
      config.frontend.siteUrl,
    ).toString(),
    purchasePath:
      eligibility === "lookup_unavailable" ? "unknown" : "no_purchase",
    eligibility,
    benefit,
  };
}
function allowance(
  limits: ResolvedLimits["limits"],
  type: RecordingLimitContext["limitType"],
) {
  return type === "weekly_recording"
    ? (limits.maxMeetingMinutesRolling ?? Infinity)
    : (limits.maxMeetingDurationMs ?? 0) / 60000;
}
function formatMinutes(value: number) {
  return value >= 60 && value % 60 === 0
    ? `${value / 60} ${value === 60 ? "hour" : "hours"}`
    : `${value} minutes`;
}
function benefitFor(tier: PaidTier, input: RecordingLimitInput) {
  const name = tier === "basic" ? "Basic" : "Pro";
  const minutes = allowance(getLimitsForTier(tier), input.limitType);
  if (input.limitType === "meeting_duration")
    return `${name} allows meetings up to ${formatMinutes(minutes)}.`;
  return minutes === Infinity
    ? "Pro has no weekly recording cap. The two-hour limit per meeting still applies."
    : `${name} includes ${formatMinutes(minutes)} per rolling week for everyone in this server.`;
}
function resolveAction(
  input: RecordingLimitInput,
  resolved: ResolvedLimits,
  hasBilling: boolean,
): LimitAction {
  if (!config.stripe.secretKey || config.subscription.stripeMode === "disabled")
    return neutralAction(input, "billing_unavailable");
  if (resolved.subscription.source === "forced")
    return neutralAction(input, "forced");
  const currentAllowance = allowance(resolved.limits, input.limitType);
  if (currentAllowance > input.limitMinutes)
    return neutralAction(
      input,
      "already_available",
      "Your current plan already provides more recording time. Its allowance applies to future recordings.",
    );
  const candidates: PaidTier[] =
    resolved.subscription.tier === "free"
      ? ["basic", "pro"]
      : resolved.subscription.tier === "basic"
        ? ["pro"]
        : [];
  const target = candidates.find(
    (tier) =>
      allowance(getLimitsForTier(tier), input.limitType) > input.limitMinutes,
  );
  if (!target) return neutralAction(input, "no_higher_limit");
  if (hasBilling)
    return {
      kind: "manage_billing",
      label: "Manage plan",
      url: contextUrl(
        input,
        `/portal/server/${encodeURIComponent(input.guildId)}/billing`,
      ).toString(),
      purchasePath: "existing_billing",
      eligibility: "existing_billing",
      targetTier: target,
      benefit: `${benefitFor(target, input)} A server manager can review the available billing options.`,
    };
  const url = contextUrl(input, "/upgrade/select-server");
  url.searchParams.set("serverId", input.guildId);
  url.searchParams.set("plan", target);
  return {
    kind: "upgrade",
    label: target === "basic" ? "View Basic" : "View Pro",
    url: url.toString(),
    purchasePath: "initial_purchase",
    eligibility: "higher_allowance",
    targetTier: target,
    benefit: benefitFor(target, input),
  };
}
async function eligibility(input: RecordingLimitInput, meeting?: MeetingData) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const reads = [
      input.resolved
        ? Promise.resolve(input.resolved)
        : getGuildLimits(input.guildId),
      getSubscriptionRepository().get(input.guildId),
    ] as const;
    const result = Promise.all(reads)
      .then(([resolved, stored]) => ({
        resolved,
        hasBilling: Boolean(
          stored?.stripeCustomerId || stored?.stripeSubscriptionId,
        ),
      }))
      .catch(() => undefined);
    if (meeting) await Promise.allSettled(reads);
    return result;
  };
  // Register before dispatch and retain both reads even when either one fails.
  if (meeting) return runMeetingProcessingEffect(meeting, read);
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 800);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function properties(notice: RecordingLimitNotice) {
  return {
    ...recordingLimitAnalytics(notice.input),
    outcome: notice.input.outcome,
    current_tier: notice.currentTier,
    target_tier: notice.action.targetTier,
    purchase_path: notice.action.purchasePath,
    action_kind: notice.action.kind,
    eligibility: notice.action.eligibility,
    limit_minutes: notice.input.limitMinutes,
    used_minutes: notice.input.usedMinutes,
    surface: notice.input.limitSurface === "mcp_start" ? "mcp" : "discord",
    event_version: 1,
  };
}
export async function encounterRecordingLimit(
  input: RecordingLimitInput,
  meeting?: MeetingData,
): Promise<RecordingLimitNotice> {
  const known = await eligibility(input, meeting);
  if (meeting) getMeetingProcessingSignal(meeting).throwIfAborted();
  const action = known
    ? resolveAction(input, known.resolved, known.hasBilling)
    : neutralAction(input, "lookup_unavailable");
  const notice: RecordingLimitNotice = {
    input,
    action,
    currentTier: known?.resolved.subscription.tier,
    payload: {
      content: `${input.message}${action.benefit ? `\n\n${action.benefit}` : ""}`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(action.label)
            .setURL(action.url),
        ),
      ],
      allowedMentions: { parse: [] },
    },
  };
  captureEvent("recording_limit_encountered", {
    guildId: input.guildId,
    userId: input.userId,
    properties: properties(notice),
  });
  return notice;
}
function noticeResult(
  notice: RecordingLimitNotice,
  delivery: "delivered" | "failed" | "suppressed",
  operation: "send" | "edit" | "suppress",
  reason?: string,
) {
  captureEvent("recording_limit_notice_result", {
    guildId: notice.input.guildId,
    userId: notice.input.userId,
    properties: {
      ...properties(notice),
      delivery,
      notice_operation: operation,
      suppression_reason: reason,
    },
  });
}
function definitelyRejectedNotice(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.status >= 400 &&
    error.status < 500
  );
}
export async function deliverRecordingLimitNotice<T>(
  notice: RecordingLimitNotice,
  operation: () => Promise<T>,
  kind: "send" | "edit" = "send",
  meeting?: MeetingData,
) {
  try {
    const value = meeting
      ? await runMeetingNoticeMutation(
          meeting,
          operation,
          definitelyRejectedNotice,
        )
      : await operation();
    noticeResult(notice, "delivered", kind);
    return { delivery: "delivered" as const, value };
  } catch (error) {
    const definite = definitelyRejectedNotice(error);
    if (meeting) {
      getMeetingProcessingSignal(meeting).throwIfAborted();
      if (!definite) throw error;
    }
    const messageMissing =
      error instanceof DiscordAPIError &&
      error.status === 404 &&
      error.code === 10008;
    noticeResult(
      notice,
      "failed",
      kind,
      messageMissing
        ? "message_missing"
        : definite
          ? "discord_rejected"
          : "delivery_unknown",
    );
    return { delivery: "failed" as const, definite, messageMissing };
  }
}
async function claimAutoNotice(
  notice: RecordingLimitNotice,
): Promise<InteractionReceipt | false | undefined> {
  if (notice.input.limitSurface !== "auto_start") return undefined;
  const now = Date.now();
  const receipt: InteractionReceipt = {
    interactionId: `recording-limit:${notice.input.guildId}:${notice.input.limitType}:${notice.input.outcome}`,
    guildId: notice.input.guildId,
    interactionKind: "recording_limit",
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + 15 * 60,
  };
  try {
    return (await tryCreateInteractionReceipt(receipt, Math.floor(now / 1000)))
      ? receipt
      : false;
  } catch {
    return undefined;
  }
}
export function notifyRecordingLimit(
  input: RecordingLimitInput,
  channel: NoticeChannel,
  state?: RecordingLimitState,
  meeting?: MeetingData,
): Promise<NoticeMessage | undefined> {
  const run = () => notifyOwnedRecordingLimit(input, channel, state, meeting);
  return meeting ? runMeetingProcessingEffect(meeting, run) : run();
}
async function notifyOwnedRecordingLimit(
  input: RecordingLimitInput,
  channel: NoticeChannel,
  state?: RecordingLimitState,
  meeting?: MeetingData,
): Promise<NoticeMessage | undefined> {
  const signal = meeting ? getMeetingProcessingSignal(meeting) : undefined;
  const notice = await encounterRecordingLimit(input, meeting);
  signal?.throwIfAborted();
  if (input.limitType === "weekly_recording" && state?.pending)
    await state.pending;
  signal?.throwIfAborted();
  if (state?.deliveryUnknown) {
    if (meeting)
      throw new Error("Earlier recording limit notice outcome is unknown");
    noticeResult(notice, "suppressed", "suppress", "previous_delivery_unknown");
    return undefined;
  }
  if (
    input.outcome === "near_limit" &&
    state?.durationContent &&
    state.message
  ) {
    noticeResult(notice, "suppressed", "suppress", "covered_by_duration");
    return state.message;
  }
  if (input.limitType === "meeting_duration" && state)
    state.durationContent = input.message;
  if (input.limitType === "weekly_recording" && state?.durationContent)
    notice.payload.content = `${state.durationContent}\n\n${notice.payload.content}`;
  const receipt = await claimAutoNotice(notice);
  signal?.throwIfAborted();
  if (receipt === false) {
    noticeResult(notice, "suppressed", "suppress", "cooldown");
    return undefined;
  }
  const existing = state?.message;
  if (existing) {
    const result = await deliverRecordingLimitNotice(
      notice,
      () => existing.edit(notice.payload),
      "edit",
      meeting,
    );
    signal?.throwIfAborted();
    if (result.delivery === "delivered") return existing;
    if (state) state.deliveryUnknown = !result.definite;
    if (!result.messageMissing) return undefined;
    if (state) state.message = undefined;
  }
  signal?.throwIfAborted();
  const result = await deliverRecordingLimitNotice(
    notice,
    () => channel.send(notice.payload),
    "send",
    meeting,
  );
  signal?.throwIfAborted();
  if (result.delivery === "delivered") {
    if (state) state.message = result.value;
    return result.value;
  }
  if (state) state.deliveryUnknown = !result.definite;
  if (receipt && result.definite) {
    try {
      await releaseInteractionReceipt(receipt);
    } catch {
      /* Receipt expiry bounds a failed cleanup. */
    }
  }
  return undefined;
}
