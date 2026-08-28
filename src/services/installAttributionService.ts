import type session from "express-session";
import type { InstallAttribution } from "../types/db";

const TOKEN_MAX_LENGTH = 64;
const DOMAIN_MAX_LENGTH = 253;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const ATTRIBUTION_TOKEN = /^[a-z0-9][a-z0-9._-]*$/;
const CTA_LOCATIONS = new Set(["hero", "footer-cta", "site-footer", "join"]);
const PUBLIC_LANDING_PATHS = new Set(["/", "/join", "/upgrade", "/feedback"]);

export const DISCORD_INSTALL_SCOPES = [
  "identify",
  "email",
  "guilds",
  "bot",
  "applications.commands",
];

type QueryValues = Record<string, unknown>;

type SessionWithInstallAttribution = Partial<session.Session> & {
  installAttribution?: InstallAttribution;
  oauthRedirect?: string;
};

export type RequestWithInstallAttribution = {
  session?: SessionWithInstallAttribution;
  installAttribution?: InstallAttribution;
};

function firstString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeToken(value: unknown): string | undefined {
  const normalized = firstString(value)?.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > TOKEN_MAX_LENGTH ||
    !ATTRIBUTION_TOKEN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function sanitizeDomain(value: unknown): string | undefined {
  const normalized = firstString(value)
    ?.trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!normalized || normalized.length > DOMAIN_MAX_LENGTH) return undefined;

  try {
    const hostname = new URL(`https://${normalized}`).hostname;
    if (hostname !== normalized || !hostname.includes(".")) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

function sanitizeLandingPath(value: unknown): string {
  const path = firstString(value)?.trim().toLowerCase();
  return path && PUBLIC_LANDING_PATHS.has(path) ? path : "other";
}

function sanitizeCtaLocation(value: unknown): string {
  const location = sanitizeToken(value);
  return location && CTA_LOCATIONS.has(location) ? location : "other";
}

export function parseInstallAttribution(
  query: QueryValues,
  capturedAt = new Date().toISOString(),
): InstallAttribution | undefined {
  if (query.dnt === "1") return undefined;
  const campaign = sanitizeToken(query.campaign);
  const referrerDomain = sanitizeDomain(query.referrer_domain);
  return {
    source: sanitizeToken(query.source) ?? "direct",
    medium: sanitizeToken(query.medium) ?? "web",
    landingPath: sanitizeLandingPath(query.landing_path),
    ctaLocation: sanitizeCtaLocation(query.cta_location),
    capturedAt,
    ...(campaign ? { campaign } : {}),
    ...(referrerDomain ? { referrerDomain } : {}),
  };
}

export function storeInstallAttributionInSession(
  req: RequestWithInstallAttribution,
  attribution: InstallAttribution | undefined,
): SessionWithInstallAttribution | undefined {
  if (!req.session) return undefined;
  if (attribution) req.session.installAttribution = attribution;
  else delete req.session.installAttribution;
  return req.session;
}

export function stashInstallAttributionFromSession(
  req: RequestWithInstallAttribution,
): InstallAttribution | undefined {
  const stored = req.session?.installAttribution;
  if (!stored) return undefined;
  delete req.session?.installAttribution;
  req.installAttribution = stored;
  return stored;
}

export function readInstallAttributionFromRequest(
  req: RequestWithInstallAttribution,
): InstallAttribution | undefined {
  return req.installAttribution;
}

export function isDiscordGuildId(value: unknown): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}

export function buildDirectDiscordInstallUrl(clientId: string): string {
  const inviteUrl = new URL("https://discord.com/oauth2/authorize");
  inviteUrl.searchParams.set("client_id", clientId);
  inviteUrl.searchParams.set("scope", "bot applications.commands");
  return inviteUrl.toString();
}
