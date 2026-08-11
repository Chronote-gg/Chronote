import crypto from "node:crypto";
import type { Profile } from "passport-discord";
import { getDesktopAuthRepository } from "../repositories/desktopAuthRepository";
import { config } from "./configService";
import {
  DESKTOP_AUTH_SCOPES,
  type DesktopAccessTokenInfo,
  type DesktopAuthScope,
  type DesktopAuthToken,
} from "../types/desktopAuth";

const ACCESS_TOKEN_BYTES = 32;
const AUTH_CODE_BYTES = 32;
const REFRESH_TOKEN_BYTES = 32;
const CODE_VERIFIER_MIN_LENGTH = 43;
const CODE_VERIFIER_MAX_LENGTH = 128;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_SCOPES: DesktopAuthScope[] = [
  "profile:read",
  "personal_uploads:write",
  "meetings:read",
];

type DesktopTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  user: {
    id: string;
    username: string;
    avatar?: string | null;
  };
};

export class DesktopAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const epochSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000);
const nowIso = () => new Date().toISOString();

const getDesktopAuthSecret = () =>
  config.server.oauthSecret || config.server.sessionSecret;

const hashDesktopToken = (token: string) =>
  crypto
    .createHmac("sha256", getDesktopAuthSecret())
    .update(token)
    .digest("base64url");

const randomToken = (bytes: number) =>
  crypto.randomBytes(bytes).toString("base64url");

export const parseDesktopScopes = (scope?: string): DesktopAuthScope[] => {
  const values = (scope?.trim() || DEFAULT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  const invalid = values.filter(
    (value): value is string =>
      !DESKTOP_AUTH_SCOPES.includes(value as DesktopAuthScope),
  );
  if (invalid.length > 0) {
    throw new DesktopAuthError("invalid_scope", "Unsupported desktop scope.");
  }
  return Array.from(new Set(values as DesktopAuthScope[]));
};

const formatDesktopScope = (scopes: DesktopAuthScope[]) => scopes.join(" ");

export const hasDesktopScopes = (
  granted: DesktopAuthScope[],
  required: DesktopAuthScope[],
) => required.every((scope) => granted.includes(scope));

export const isDesktopRedirectUriAllowed = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      return false;
    }
    return url.pathname === "/auth/callback";
  } catch {
    return false;
  }
};

const assertPkceVerifier = (codeVerifier: string) => {
  if (
    codeVerifier.length < CODE_VERIFIER_MIN_LENGTH ||
    codeVerifier.length > CODE_VERIFIER_MAX_LENGTH ||
    !PKCE_VERIFIER_PATTERN.test(codeVerifier)
  ) {
    throw new DesktopAuthError("invalid_grant", "Invalid PKCE code verifier.");
  }
};

const createPkceChallenge = (codeVerifier: string) =>
  crypto.createHash("sha256").update(codeVerifier).digest("base64url");

const issueTokenPair = async (params: {
  userId: string;
  username: string;
  avatar?: string | null;
  scopes: DesktopAuthScope[];
}): Promise<DesktopTokenResponse> => {
  const repository = getDesktopAuthRepository();
  const createdAt = nowIso();
  const accessToken = `desktop_at_${randomToken(ACCESS_TOKEN_BYTES)}`;
  const refreshToken = `desktop_rt_${randomToken(REFRESH_TOKEN_BYTES)}`;
  const accessTokenHash = hashDesktopToken(accessToken);
  const refreshTokenHash = hashDesktopToken(refreshToken);
  const scope = formatDesktopScope(params.scopes);

  await Promise.all([
    repository.writeToken({
      tokenHash: accessTokenHash,
      tokenType: "access",
      pairedTokenHash: refreshTokenHash,
      userId: params.userId,
      username: params.username,
      avatar: params.avatar,
      scope,
      createdAt,
      expiresAt: epochSeconds() + ACCESS_TOKEN_TTL_SECONDS,
    }),
    repository.writeToken({
      tokenHash: refreshTokenHash,
      tokenType: "refresh",
      pairedTokenHash: accessTokenHash,
      userId: params.userId,
      username: params.username,
      avatar: params.avatar,
      scope,
      createdAt,
      expiresAt: epochSeconds() + REFRESH_TOKEN_TTL_SECONDS,
    }),
  ]);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
    user: {
      id: params.userId,
      username: params.username,
      avatar: params.avatar,
    },
  };
};

export async function issueDesktopAuthorizationCode(params: {
  user: Pick<Profile, "id" | "username" | "avatar">;
  redirectUri: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
}) {
  if (!isDesktopRedirectUriAllowed(params.redirectUri)) {
    throw new DesktopAuthError(
      "invalid_redirect_uri",
      "Desktop redirect URI must use localhost HTTP.",
    );
  }
  if (params.codeChallengeMethod !== "S256") {
    throw new DesktopAuthError("invalid_request", "PKCE S256 is required.");
  }
  const scopes = parseDesktopScopes(params.scope);
  const code = `desktop_code_${randomToken(AUTH_CODE_BYTES)}`;
  await getDesktopAuthRepository().writeAuthorizationCode({
    codeHash: hashDesktopToken(code),
    userId: params.user.id,
    username: params.user.username,
    avatar: params.user.avatar,
    redirectUri: params.redirectUri,
    scope: formatDesktopScope(scopes),
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    createdAt: nowIso(),
    expiresAt: epochSeconds() + AUTH_CODE_TTL_SECONDS,
  });
  return code;
}

export async function exchangeDesktopAuthorizationCode(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<DesktopTokenResponse> {
  assertPkceVerifier(params.codeVerifier);
  const repository = getDesktopAuthRepository();
  const code = await repository.consumeAuthorizationCode(
    hashDesktopToken(params.code),
  );
  if (!code) {
    throw new DesktopAuthError("invalid_grant", "Invalid authorization code.");
  }
  if (code.expiresAt <= epochSeconds()) {
    throw new DesktopAuthError("invalid_grant", "Authorization code expired.");
  }
  if (code.redirectUri !== params.redirectUri) {
    throw new DesktopAuthError("invalid_grant", "Authorization code mismatch.");
  }
  if (createPkceChallenge(params.codeVerifier) !== code.codeChallenge) {
    throw new DesktopAuthError("invalid_grant", "Invalid PKCE code verifier.");
  }
  return issueTokenPair({
    userId: code.userId,
    username: code.username,
    avatar: code.avatar,
    scopes: parseDesktopScopes(code.scope),
  });
}

function assertUsableRefreshToken(
  token: DesktopAuthToken | undefined,
  now: number,
): asserts token is DesktopAuthToken {
  if (!token || token.expiresAt <= now) {
    throw new DesktopAuthError("invalid_grant", "Invalid refresh token.");
  }
}

export async function refreshDesktopAccessToken(params: {
  refreshToken: string;
}) {
  const repository = getDesktopAuthRepository();
  const tokenHash = hashDesktopToken(params.refreshToken);
  const token = await repository.consumeToken("refresh", tokenHash);
  assertUsableRefreshToken(token, epochSeconds());
  if (token.pairedTokenHash) {
    await repository.deleteToken("access", token.pairedTokenHash);
  }
  return issueTokenPair({
    userId: token.userId,
    username: token.username,
    avatar: token.avatar,
    scopes: parseDesktopScopes(token.scope),
  });
}

export async function revokeDesktopToken(token: string) {
  const tokenHash = hashDesktopToken(token);
  const repository = getDesktopAuthRepository();
  const accessToken = await repository.consumeToken("access", tokenHash);
  if (accessToken?.pairedTokenHash) {
    await repository.deleteToken("refresh", accessToken.pairedTokenHash);
    return;
  }
  const refreshToken = await repository.consumeToken("refresh", tokenHash);
  if (refreshToken?.pairedTokenHash) {
    await repository.deleteToken("access", refreshToken.pairedTokenHash);
  }
}

export async function validateDesktopAccessToken(
  token: string,
): Promise<DesktopAccessTokenInfo | undefined> {
  const record = await getDesktopAuthRepository().getToken(
    "access",
    hashDesktopToken(token),
  );
  if (!record || record.expiresAt <= epochSeconds()) return undefined;
  try {
    return {
      userId: record.userId,
      username: record.username,
      avatar: record.avatar,
      scopes: parseDesktopScopes(record.scope),
      expiresAt: record.expiresAt,
    };
  } catch {
    return undefined;
  }
}
