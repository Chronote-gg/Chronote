import posthog from "posthog-js";
import { resolveAnalyticsEnvironment } from "../../utils/purchaseAnalytics";

type AnalyticsGlobal = {
  __POSTHOG_KEY__?: string;
  __POSTHOG_HOST__?: string;
};

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Vite leaves the literal "%VITE_FOO%" in index.html when the variable is not
 * defined at build time, so treat that (and empty strings) as "not configured".
 */
function resolveInjectedValue(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("%")) return "";
  return trimmed;
}

const readGlobals = () => globalThis as AnalyticsGlobal;

export function isDoNotTrackEnabled(): boolean {
  return globalThis.navigator?.doNotTrack === "1";
}

const resolveKey = () => resolveInjectedValue(readGlobals().__POSTHOG_KEY__);

/**
 * Share links are bearer credentials: anyone holding the id can read the
 * meeting or conversation. Automatic pageview capture would otherwise hand
 * those ids to a third party, so replace them before anything is sent.
 */
const SHARE_ID_PATTERN = /\/share\/(meeting|ask)\/[^/?#]+\/[^/?#]+/g;

function isPrivateQueryKey(key: string): boolean {
  try {
    // Encoded return URLs add a second encoding layer to query keys.
    return ["promo", "promotioncode", "source"].includes(
      decodeURIComponent(decodeURIComponent(key)).toLowerCase(),
    );
  } catch {
    return false;
  }
}

export function redactShareIds(value: string, depth = 0): string {
  // Bound nested return URLs and discard deeper values rather than leaking them.
  if (depth > 8) return "[redacted]";
  return value
    .replace(SHARE_ID_PATTERN, "/share/$1/:serverId/:shareId")
    .replace(/\/promo\/[^/?#]+/gi, "/promo/:code")
    .replace(/%2fpromo%2f(?:(?!%2f|%3f|%23|%26).)+/gi, "%2Fpromo%2F%3Acode")
    .replace(
      /([?&])([^=&#]+)=([^&#]*)/g,
      (match, separator, key, queryValue) => {
        if (isPrivateQueryKey(key)) return `${separator}${key}=[redacted]`;
        try {
          const decoded = decodeURIComponent(queryValue);
          const sanitized = redactShareIds(decoded, depth + 1);
          return sanitized === decoded
            ? match
            : `${separator}${key}=${encodeURIComponent(sanitized)}`;
        } catch {
          return match;
        }
      },
    )
    .replace(
      /(%3f|%26)((?:(?!%3d|%26|%23).)+)%3d.*?(?=%26|%23|$)/gi,
      (match, separator, key) =>
        isPrivateQueryKey(key) ? `${separator}${key}%3D%5Bredacted%5D` : match,
    );
}

/**
 * Share ids turn up nested inside replay and autocapture payloads, not just as
 * top level properties, so this walks the whole structure.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactShareIds(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactDeep(nested),
      ]),
    );
  }
  return value;
}

function sanitizeProperties(properties: Record<string, unknown>) {
  return redactDeep(properties) as Record<string, unknown>;
}

/**
 * No-ops when no key is configured, which keeps local dev, Jest, Playwright
 * mock runs, and CI builds free of analytics traffic.
 */
export function initAnalytics() {
  const key = resolveKey();
  if (!key || isDoNotTrackEnabled()) return;
  posthog.init(key, {
    api_host:
      resolveInjectedValue(readGlobals().__POSTHOG_HOST__) ||
      DEFAULT_POSTHOG_HOST,
    // The portal is a single page app, so pageviews have to follow history
    // API navigation rather than full document loads.
    capture_pageview: "history_change",
    respect_dnt: true,
    // Autocapture is on because the product needs behavioural data and the
    // privacy policy discloses it. Session replay is NOT enabled here: it is
    // gated project-side by `session_recording_opt_in`, so this config alone
    // records nothing. Share ids are still redacted below, because those are
    // bearer credentials rather than analytics data.
    sanitize_properties: sanitizeProperties,
  });
}

/**
 * Ties portal activity to the same Discord user id the bot sends server-side,
 * so a person's portal and in-Discord behaviour resolve to one person rather
 * than two anonymous ones.
 */
export function identifyUser(userId: string) {
  if (!resolveKey() || isDoNotTrackEnabled()) return;
  posthog.identify(userId);
}

/** Clears the identity on logout so the next visitor is not merged into it. */
export function resetAnalyticsIdentity() {
  if (!resolveKey()) return;
  posthog.reset();
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!resolveKey() || isDoNotTrackEnabled()) return;
  try {
    posthog.capture(event, {
      ...properties,
      environment: resolveAnalyticsEnvironment(window.location.origin),
      surface: properties?.surface ?? "web",
    });
  } catch {
    // Analytics must not interrupt authentication, navigation or checkout.
  }
}
