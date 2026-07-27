import posthog from "posthog-js";

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

const resolveKey = () => resolveInjectedValue(readGlobals().__POSTHOG_KEY__);

/**
 * No-ops when no key is configured, which keeps local dev, Jest, Playwright
 * mock runs, and CI builds free of analytics traffic.
 */
export function initAnalytics() {
  const key = resolveKey();
  if (!key) return;
  posthog.init(key, {
    api_host:
      resolveInjectedValue(readGlobals().__POSTHOG_HOST__) ||
      DEFAULT_POSTHOG_HOST,
    // The portal is a single page app, so pageviews have to follow history
    // API navigation rather than full document loads.
    capture_pageview: "history_change",
    respect_dnt: true,
  });
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!resolveKey()) return;
  posthog.capture(event, properties);
}
