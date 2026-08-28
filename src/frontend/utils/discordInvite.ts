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

export function buildInstallUrl({
  ctaLocation,
  currentUrl = typeof window === "undefined" ? undefined : window.location.href,
  referrer = typeof document === "undefined" ? undefined : document.referrer,
  doNotTrack = isDoNotTrackEnabled(),
}: InstallLinkOptions): string {
  if (doNotTrack) return `${buildApiUrl("/auth/discord/install")}?dnt=1`;
  const page = readUrl(currentUrl);
  const referringPage = readUrl(referrer);
  const referringHostname = referringPage?.hostname.replace(/^www\./, "");
  const referrerDomain =
    referringHostname === "chronote.gg" ||
    referringHostname?.endsWith(".chronote.gg")
      ? undefined
      : referringHostname;
  const source =
    sanitizeToken(page?.searchParams.get("utm_source")) ||
    referrerDomain ||
    "direct";
  const medium =
    sanitizeToken(page?.searchParams.get("utm_medium")) ||
    (referrerDomain ? "referral" : "web");
  const campaign = sanitizeToken(page?.searchParams.get("utm_campaign"));
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
