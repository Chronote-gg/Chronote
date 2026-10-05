import { tryCreateInteractionReceipt } from "../db";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type { MeetingData } from "../types/meeting-data";
import { config } from "./configService";
import { resolveGuildSubscription } from "./subscriptionService";

const UPGRADE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

export async function claimSummaryUpgradeUrl(
  meeting: MeetingData,
): Promise<string | undefined> {
  if (
    meeting.cancelled ||
    !meeting.generateNotes ||
    !meeting.notesText?.trim() ||
    meeting.processing?.notes !== "generated" ||
    meeting.processing?.transcription !== "ready" ||
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
    return claimed ? url.toString() : undefined;
  } catch (error) {
    console.warn("Could not prepare meeting summary upgrade", error);
    return undefined;
  }
}
