import type { AuthedProfile } from "../trpc/context";
import { config } from "./configService";

const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_DEFAULT_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_REFRESH_GRACE_MS = 60 * 1000;

type DiscordTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

type DiscordTokenErrorPayload = {
  error?: string;
  error_description?: string;
};

type DiscordTokenRefreshSuccess = {
  ok: true;
  token: DiscordTokenResponse;
};

type DiscordTokenRefreshFailure = {
  ok: false;
  status: number;
  error?: string;
  errorDescription?: string;
};

type DiscordTokenRefreshResult =
  DiscordTokenRefreshSuccess | DiscordTokenRefreshFailure;

type DiscordRefreshErrorSummary = {
  status: number;
  error?: string;
  errorDescription?: string;
};

export type EnsureDiscordAccessTokenResult = {
  user: AuthedProfile;
  refreshed: boolean;
  shouldLogout: boolean;
  error?: DiscordRefreshErrorSummary;
};

const parseExpiresInSeconds = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const resolveTokenExpiresAt = (expiresIn?: unknown) => {
  const nowMs = Date.now();
  const seconds = parseExpiresInSeconds(expiresIn);
  return nowMs + (seconds ? seconds * 1000 : DISCORD_DEFAULT_EXPIRES_MS);
};

const shouldLogoutForRefreshError = (error?: string) =>
  error === "invalid_grant" || error === "invalid_client";

const readDiscordErrorPayload = async (response: Response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as DiscordTokenErrorPayload;
  } catch {
    return {};
  }
};

export function buildDiscordAuthProfile(
  profile: AuthedProfile,
  accessToken: string,
  refreshToken: string,
  expiresIn?: unknown,
): AuthedProfile {
  return {
    ...profile,
    accessToken,
    refreshToken,
    tokenExpiresAt: resolveTokenExpiresAt(expiresIn),
  };
}

export function isDiscordTokenFresh(user: AuthedProfile, nowMs = Date.now()) {
  const expiresAt = user.tokenExpiresAt ?? 0;
  return expiresAt - DISCORD_REFRESH_GRACE_MS > nowMs;
}

export async function refreshDiscordAccessToken(
  refreshToken: string,
): Promise<DiscordTokenRefreshResult> {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const payload = await readDiscordErrorPayload(response);
    return {
      ok: false,
      status: response.status,
      error: payload.error,
      errorDescription: payload.error_description,
    };
  }

  return {
    ok: true,
    token: (await response.json()) as DiscordTokenResponse,
  };
}

export async function ensureDiscordAccessToken(
  user: AuthedProfile,
): Promise<EnsureDiscordAccessTokenResult> {
  if (!user.refreshToken) {
    return { user, refreshed: false, shouldLogout: false };
  }
  if (isDiscordTokenFresh(user)) {
    return { user, refreshed: false, shouldLogout: false };
  }

  const refreshed = await refreshDiscordAccessToken(user.refreshToken);
  if (!refreshed.ok) {
    const errorSummary: DiscordRefreshErrorSummary = {
      status: refreshed.status,
      error: refreshed.error,
      errorDescription: refreshed.errorDescription,
    };
    console.error("Failed to refresh Discord token", errorSummary);
    return {
      user,
      refreshed: false,
      shouldLogout: shouldLogoutForRefreshError(refreshed.error),
      error: errorSummary,
    };
  }

  return {
    user: {
      ...user,
      accessToken: refreshed.token.access_token,
      refreshToken: refreshed.token.refresh_token ?? user.refreshToken,
      tokenExpiresAt: resolveTokenExpiresAt(refreshed.token.expires_in),
    },
    refreshed: true,
    shouldLogout: false,
  };
}
