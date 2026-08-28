import { buildApiUrl } from "../services/apiClient";
import { isDoNotTrackEnabled } from "../services/analytics";

type InstallLinkOptions = {
  ctaLocation: "hero" | "footer-cta" | "site-footer" | "join";
  currentUrl?: string;
  referrer?: string;
  doNotTrack?: boolean;
};

const ATTRIBUTION_TOKEN = /^[a-z0-9][a-z0-9._-]*$/;
const PUBLIC_LANDING_PATHS = new Set(["/", "/join", "/upgrade", "/feedback"]);
const ACQUISITION_SOURCES = new Set([
  "direct",
  "newsletter",
  "discord",
  "github",
  "google",
  "bing",
  "reddit",
  "producthunt",
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "x",
]);
const ACQUISITION_MEDIUMS = new Set([
  "web",
  "referral",
  "email",
  "organic",
  "social",
  "paid",
  "partner",
]);
const ACQUISITION_CAMPAIGNS = new Set([
  "launch",
  "readme",
  "homepage",
  "join_page",
  "app_directory",
  "docs",
]);

function sanitizeToken(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 64 ||
    !ATTRIBUTION_TOKEN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function readUrl(value?: string): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function sanitizeDomain(value: string | undefined): string | undefined {
  const domain = value?.toLowerCase().replace(/^www\./, "");
  if (!domain || domain === "chronote.gg" || domain.endsWith(".chronote.gg")) {
    return undefined;
  }
  return domain;
}

function sanitizeSource(value: string | null | undefined): string | undefined {
  const source = sanitizeToken(value);
  if (!source) return undefined;
  if (ACQUISITION_SOURCES.has(source)) return source;
  try {
    const domain = new URL(`https://${source}`).hostname;
    return domain === source && domain.includes(".")
      ? sanitizeDomain(domain)
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeCategory(
  value: string | null | undefined,
  allowedValues: ReadonlySet<string>,
): string | undefined {
  const category = sanitizeToken(value);
  return category && allowedValues.has(category) ? category : undefined;
}

export function buildInstallUrl({
  ctaLocation,
  currentUrl = typeof window === "undefined" ? undefined : window.location.href,
  referrer = typeof document === "undefined" ? undefined : document.referrer,
  doNotTrack = isDoNotTrackEnabled(),
}: InstallLinkOptions): string {
  if (doNotTrack) return `${buildApiUrl("/auth/discord/install")}?dnt=1`;
  const page = readUrl(currentUrl);
  const referringPage = readUrl(referrer);
  const referrerDomain = sanitizeDomain(referringPage?.hostname);
  const source =
    sanitizeSource(page?.searchParams.get("utm_source")) ||
    referrerDomain ||
    "direct";
  const medium =
    sanitizeCategory(
      page?.searchParams.get("utm_medium"),
      ACQUISITION_MEDIUMS,
    ) || (referrerDomain ? "referral" : "web");
  const campaign = sanitizeCategory(
    page?.searchParams.get("utm_campaign"),
    ACQUISITION_CAMPAIGNS,
  );
  const pagePath = page?.pathname.toLowerCase();
  const landingPath =
    pagePath && PUBLIC_LANDING_PATHS.has(pagePath) ? pagePath : "other";
  const params = new URLSearchParams({
    source,
    medium,
    landing_path: landingPath,
    cta_location: ctaLocation,
  });
  if (campaign) params.set("campaign", campaign);
  if (referrerDomain) params.set("referrer_domain", referrerDomain);
  return `${buildApiUrl("/auth/discord/install")}?${params.toString()}`;
}
