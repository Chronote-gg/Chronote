import { PostHog } from "posthog-node";
import { config } from "./configService";

/**
 * Server-side product analytics.
 *
 * This is deliberately separate from `metrics.ts`: those are Prometheus
 * counters for Grafana, which are dimensionless and cannot answer "which
 * server" or "which person". These events carry identity and properties.
 *
 * Properties must describe the *shape* of an action (counts, lengths, enums)
 * and never its content. Meeting notes, context prompts, and dictionary terms
 * are user data and must not leave the system as event properties.
 *
 * Two identifiers are sent deliberately, and they are the only two: the guild,
 * because server-level analysis is the point of this at all, and the acting
 * Discord user as the distinct id, so portal and bot activity resolve to one
 * person. Anything finer grained, a channel or message id for instance, is a
 * stable identifier wearing a property's clothes. Add one only with a question
 * that needs it and a matching line in the privacy policy.
 */

type AnalyticsProperties = Record<
  string,
  string | number | boolean | undefined
>;

type CaptureArgs = {
  /** Discord user id of whoever took the action, when there is one. */
  userId?: string;
  /** Always set this when the action belongs to a guild. */
  guildId?: string;
  properties?: AnalyticsProperties;
};

let client: PostHog | null = null;

/**
 * No-ops when no key is configured, which keeps local dev, Jest, and CI free
 * of analytics traffic, the same way the frontend does.
 */
function getClient(): PostHog | null {
  if (!config.analytics.posthogKey) return null;
  client ??= new PostHog(config.analytics.posthogKey, {
    host: config.analytics.posthogHost,
  });
  return client;
}

/**
 * Server-level events have no acting user, so they are keyed by guild. Person
 * counts stay meaningful because these ids are namespaced and never collide
 * with Discord user ids.
 */
function resolveDistinctId(userId?: string, guildId?: string): string | null {
  if (userId) return userId;
  if (guildId) return `guild:${guildId}`;
  return null;
}

export function captureEvent(
  event: string,
  { userId, guildId, properties }: CaptureArgs = {},
): void {
  // Everything, including client construction, stays inside the guard:
  // analytics must never take down a meeting, and building the client reads
  // config and can throw on its own.
  try {
    const posthog = getClient();
    if (!posthog) return;

    const distinctId = resolveDistinctId(userId, guildId);
    if (!distinctId) return;

    posthog.capture({
      distinctId,
      event,
      properties: { ...properties, guild_id: guildId },
    });
  } catch (error) {
    console.warn("Analytics capture failed", { event, error });
  }
}

/**
 * Flushes buffered events. Deploys replace the ECS task, and posthog-node
 * batches, so without this every event still in the buffer is lost. A dropped
 * event is permanent: nothing later reconstructs it.
 */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (error) {
    console.warn("Analytics shutdown failed", { error });
  } finally {
    client = null;
  }
}
