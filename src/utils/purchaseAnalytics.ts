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
