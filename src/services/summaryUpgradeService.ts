import { getInteractionReceipt, tryCreateInteractionReceipt } from "../db";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type { MeetingData } from "../types/meeting-data";
import { config } from "./configService";
import { listAllMeetingsForGuildService } from "./meetingHistoryService";
import { resolveGuildSubscription } from "./subscriptionService";

const UPGRADE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const UPGRADE_LOOKUP_BUDGET_MS = 1000;

function hasReadyRecordedNotes(meeting: MeetingData): boolean {
  return (
    meeting.transcribeMeeting &&
    meeting.generateNotes &&
    Boolean(meeting.notesText?.trim()) &&
    meeting.processing?.notes === "generated" &&
    meeting.processing.transcription === "ready"
  );
}

async function getSummaryRecordedSeconds(
  meeting: MeetingData,
  endTime: Date,
  signal: AbortSignal,
) {
  // Summary delivery precedes the final history write. Replace any earlier
  // snapshot of this meeting with its completed duration, exactly once.
  const currentSeconds = Math.floor(
    (endTime.getTime() - meeting.startTime.getTime()) / 1000,
  );
  if (!Number.isFinite(currentSeconds) || currentSeconds < 0)
    throw new Error("Invalid completed meeting duration");
  // ponytail: scan retained history only outside the active cooldown; use a
  // stored aggregate if large server histories make this query expensive.
  const history = await listAllMeetingsForGuildService(meeting.guildId, signal);
  return history.reduce(
    (total, saved) =>
      saved.meetingId !== meeting.meetingId &&
      saved.transcribeMeeting &&
      Number.isFinite(saved.duration) &&
      saved.duration > 0
        ? total + saved.duration
        : total,
    currentSeconds,
  );
}

async function prepareSummaryUpgrade(
  meeting: MeetingData,
  signal: AbortSignal,
): Promise<{ url: string; recordedSeconds: number } | undefined> {
  if (
    meeting.cancelled ||
    !hasReadyRecordedNotes(meeting) ||
    !meeting.endTime ||
    !config.stripe.secretKey ||
    config.subscription.stripeMode === "disabled"
  ) {
    return undefined;
  }

  try {
    const subscription = await resolveGuildSubscription(meeting.guildId);
    signal.throwIfAborted();
    if (subscription.tier !== "free" || subscription.source === "forced") {
      return undefined;
    }
    const stored = await getSubscriptionRepository().get(meeting.guildId);
    signal.throwIfAborted();
    // Existing billing pointers take the separately guarded transition path.
    if (stored?.stripeSubscriptionId || stored?.stripeCustomerId) {
      return undefined;
    }

    const interactionId = `summary-upgrade:${meeting.guildId}`;
    const receipt = await getInteractionReceipt(interactionId);
    signal.throwIfAborted();
    if (receipt && receipt.expiresAt > Math.floor(Date.now() / 1000))
      return undefined;
    const recordedSeconds = await getSummaryRecordedSeconds(
      meeting,
      meeting.endTime,
      signal,
    );
    signal.throwIfAborted();

    const url = new URL("/upgrade/select-server", config.frontend.siteUrl);
    url.searchParams.set("serverId", meeting.guildId);
    url.searchParams.set("plan", "basic");
    const now = Date.now();
    // ponytail: reserve before delivery; failed delivery consumes this week's
    // reminder. Prefer that to duplicate promotion.
    const claimed = await tryCreateInteractionReceipt(
      {
        interactionId,
        interactionKind: "summary_upgrade",
        guildId: meeting.guildId,
        createdAt: new Date(now).toISOString(),
        expiresAt: Math.floor(now / 1000) + UPGRADE_COOLDOWN_SECONDS,
      },
      Math.floor(now / 1000),
    );
    signal.throwIfAborted();
    if (!claimed) return undefined;
    return { url: url.toString(), recordedSeconds };
  } catch (error) {
    if (!signal.aborted)
      console.warn("Could not prepare meeting summary upgrade", error);
    return undefined;
  }
}

export async function claimSummaryUpgrade(meeting: MeetingData) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, UPGRADE_LOOKUP_BUDGET_MS);
  });
  try {
    return await Promise.race([
      prepareSummaryUpgrade(meeting, controller.signal),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
