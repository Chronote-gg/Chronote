import { tryCreateInteractionReceipt } from "../db";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type { MeetingData } from "../types/meeting-data";
import { config } from "./configService";
import { listAllMeetingsForGuildService } from "./meetingHistoryService";
import { resolveGuildSubscription } from "./subscriptionService";

const UPGRADE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

async function getSummaryRecordedSeconds(meeting: MeetingData, endTime: Date) {
  // Summary delivery precedes the final history write. Replace any earlier
  // snapshot of this meeting with its completed duration, exactly once.
  const currentSeconds = Math.floor(
    (endTime.getTime() - meeting.startTime.getTime()) / 1000,
  );
  if (!Number.isFinite(currentSeconds) || currentSeconds < 0)
    throw new Error("Invalid completed meeting duration");
  // ponytail: total retained history at most once per week; use a stored
  // aggregate if large server histories make this query expensive.
  const history = await listAllMeetingsForGuildService(meeting.guildId);
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

export async function claimSummaryUpgrade(
  meeting: MeetingData,
): Promise<{ url: string; recordedSeconds: number } | undefined> {
  if (
    meeting.cancelled ||
    !meeting.transcribeMeeting ||
    !meeting.generateNotes ||
    !meeting.notesText?.trim() ||
    meeting.processing?.notes !== "generated" ||
    meeting.processing?.transcription !== "ready" ||
    !meeting.endTime ||
    !config.stripe.secretKey ||
    config.subscription.stripeMode === "disabled"
  ) {
    return undefined;
  }

  try {
    const subscription = await resolveGuildSubscription(meeting.guildId);
    if (subscription.tier !== "free" || subscription.source === "forced") {
      return undefined;
    }
    const stored = await getSubscriptionRepository().get(meeting.guildId);
    // Existing billing pointers take the separately guarded transition path.
    if (stored?.stripeSubscriptionId || stored?.stripeCustomerId) {
      return undefined;
    }

    const url = new URL("/upgrade/select-server", config.frontend.siteUrl);
    url.searchParams.set("serverId", meeting.guildId);
    url.searchParams.set("plan", "basic");
    const now = Date.now();
    // ponytail: reserve before delivery; failures and delayed TTL cleanup may
    // suppress a nudge longer than a week. Prefer that to duplicate promotion.
    const claimed = await tryCreateInteractionReceipt({
      interactionId: `summary-upgrade:${meeting.guildId}`,
      interactionKind: "summary_upgrade",
      guildId: meeting.guildId,
      createdAt: new Date(now).toISOString(),
      expiresAt: Math.floor(now / 1000) + UPGRADE_COOLDOWN_SECONDS,
    });
    if (!claimed) return undefined;
    return {
      url: url.toString(),
      recordedSeconds: await getSummaryRecordedSeconds(
        meeting,
        meeting.endTime,
      ),
    };
  } catch (error) {
    console.warn("Could not prepare meeting summary upgrade", error);
    return undefined;
  }
}
