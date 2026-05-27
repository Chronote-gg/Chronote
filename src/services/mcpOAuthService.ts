import crypto from "node:crypto";
import { config } from "./configService";
import { getMcpOAuthRepository } from "../repositories/mcpOAuthRepository";
import {
  MCP_SCOPES,
  type McpAccessTokenInfo,
  type McpOAuthClient,
  type McpOAuthToken,
  type McpScope,
} from "../types/mcpOAuth";

const ACCESS_TOKEN_BYTES = 32;
const CLIENT_ID_BYTES = 24;
const AUTH_CODE_BYTES = 32;
const REFRESH_TOKEN_BYTES = 32;
const CODE_VERIFIER_MIN_LENGTH = 43;
const CODE_VERIFIER_MAX_LENGTH = 128;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;
const BEARER_TOKEN_TYPE = "Bearer";
const DEFAULT_SCOPE = "meetings:read";
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];
const SUPPORTED_RESPONSE_TYPES = ["code"];
const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD = "none";
const SCOPE_CHALLENGE_TTL_SECONDS = 5 * 60;

type McpBearerChallengeOptions = {
  error?: string;
  errorDescription?: string;
  scope?: string;
};

export class McpOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const epochSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000);

export const getMcpResourceUrl = () =>
  `${config.mcp.publicBaseUrl}${config.mcp.endpointPath}`;

export const getMcpProtectedResourceMetadataUrl = () =>
  `${config.mcp.publicBaseUrl}/.well-known/oauth-protected-resource${config.mcp.endpointPath}`;

export const getMcpIssuer = () => config.mcp.publicBaseUrl;

const quoteBearerChallengeValue = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const bearerChallengeParam = (name: string, value: string) =>
  `${name}=${quoteBearerChallengeValue(value)}`;

export const buildMcpBearerChallenge = (
  scopeOrOptions: string | McpBearerChallengeOptions = DEFAULT_SCOPE,
) => {
  const options =
    typeof scopeOrOptions === "string"
      ? { scope: scopeOrOptions }
      : scopeOrOptions;
  const scope = options.scope;
  const params = [
    bearerChallengeParam(
      "resource_metadata",
      getMcpProtectedResourceMetadataUrl(),
    ),
  ];
  if (options.error) params.push(bearerChallengeParam("error", options.error));
  if (options.errorDescription) {
    params.push(
      bearerChallengeParam("error_description", options.errorDescription),
    );
  }
  if (scope) params.push(bearerChallengeParam("scope", scope));
  return `${BEARER_TOKEN_TYPE} ${params.join(", ")}`;
};

export const parseMcpScopes = (scope?: string): McpScope[] => {
  const values = (scope?.trim() || DEFAULT_SCOPE).split(/\s+/).filter(Boolean);
  const invalid = values.filter(
    (value): value is string => !MCP_SCOPES.includes(value as McpScope),
  );
  if (invalid.length > 0) {
    throw new McpOAuthError("invalid_scope", "Unsupported MCP scope.");
  }
  return Array.from(new Set(values as McpScope[]));
};

export const formatMcpScope = (scopes: McpScope[]) => scopes.join(" ");

export const hasMcpScopes = (granted: McpScope[], required: McpScope[]) =>
  required.every((scope) => granted.includes(scope));

const randomToken = (bytes: number) =>
  crypto.randomBytes(bytes).toString("base64url");

export const getMcpOAuthSecret = () => {
  if (!config.server.oauthSecret) {
    throw new McpOAuthError(
      "server_error",
      "MCP OAuth secret is not configured.",
      500,
    );
  }
  return config.server.oauthSecret;
};

export const hashMcpToken = (token: string) =>
  crypto
    .createHmac("sha256", getMcpOAuthSecret())
    .update(token)
    .digest("base64url");

const isHttpsOrLocalhostUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
};

const assertValidRedirectUri = (redirectUri: string) => {
  if (!isHttpsOrLocalhostUrl(redirectUri)) {
    throw new McpOAuthError(
      "invalid_redirect_uri",
      "Redirect URIs must use HTTPS or localhost HTTP.",
    );
  }
};

const resolveSupportedClientValues = (
  values: string[] | undefined,
  supportedValues: string[],
) => {
  if (values === undefined || values.length === 0) return supportedValues;
  if (!Array.isArray(values)) {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "Unsupported MCP client metadata.",
    );
  }
  const requestedValues = Array.from(new Set(values));
  if (requestedValues.some((value) => !supportedValues.includes(value))) {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "Unsupported MCP client metadata.",
    );
  }
  return requestedValues;
};

const resolveTokenEndpointAuthMethod = (method?: string): "none" => {
  if (method === undefined || method === SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD) {
    return SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD;
  }
  throw new McpOAuthError(
    "invalid_client_metadata",
    "Unsupported MCP client metadata.",
  );
};

const assertClientRedirectUri = (
  client: McpOAuthClient,
  redirectUri: string,
) => {
  if (!client.redirectUris.includes(redirectUri)) {
    throw new McpOAuthError(
      "invalid_grant",
      "Redirect URI does not match the registered client.",
    );
  }
};

function assertMcpResource(resource?: string): asserts resource is string {
  if (resource !== getMcpResourceUrl()) {
    throw new McpOAuthError(
      "invalid_target",
      "OAuth resource must match the Chronote MCP endpoint.",
    );
  }
}

const assertPkceVerifier = (codeVerifier: string) => {
  if (
    codeVerifier.length < CODE_VERIFIER_MIN_LENGTH ||
    codeVerifier.length > CODE_VERIFIER_MAX_LENGTH ||
    !PKCE_VERIFIER_PATTERN.test(codeVerifier)
  ) {
    throw new McpOAuthError("invalid_grant", "Invalid PKCE code verifier.");
  }
};

const createPkceChallenge = (codeVerifier: string) =>
  crypto.createHash("sha256").update(codeVerifier).digest("base64url");

const nowIso = () => new Date().toISOString();

const getActiveScopeChallenge = (
  token: McpOAuthToken | undefined,
  now: number,
) => {
  if (
    !token?.scopeChallenge ||
    !token.scopeChallengeExpiresAt ||
    token.scopeChallengeExpiresAt <= now
  ) {
    return undefined;
  }
  return parseMcpScopes(token.scopeChallenge);
};

const issueTokenPair = async (params: {
  clientId: string;
  userId: string;
  scopes: McpScope[];
  resource: string;
}) => {
  const repository = getMcpOAuthRepository();
  const createdAt = nowIso();
  const accessToken = `mcp_at_${randomToken(ACCESS_TOKEN_BYTES)}`;
  const refreshToken = `mcp_rt_${randomToken(REFRESH_TOKEN_BYTES)}`;
  const accessTokenHash = hashMcpToken(accessToken);
  const refreshTokenHash = hashMcpToken(refreshToken);
  const accessExpiresAt = epochSeconds() + config.mcp.accessTokenTtlSeconds;
  const refreshExpiresAt = epochSeconds() + config.mcp.refreshTokenTtlSeconds;
  const scope = formatMcpScope(params.scopes);

  await Promise.all([
    repository.writeToken({
      tokenHash: accessTokenHash,
      tokenType: "access",
      pairedTokenHash: refreshTokenHash,
      clientId: params.clientId,
      userId: params.userId,
      scope,
      resource: params.resource,
      createdAt,
      expiresAt: accessExpiresAt,
    }),
    repository.writeToken({
      tokenHash: refreshTokenHash,
      tokenType: "refresh",
      pairedTokenHash: accessTokenHash,
      clientId: params.clientId,
      userId: params.userId,
      scope,
      resource: params.resource,
      createdAt,
      expiresAt: refreshExpiresAt,
    }),
  ]);

  return {
    access_token: accessToken,
    token_type: BEARER_TOKEN_TYPE,
    expires_in: config.mcp.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope,
  };
};

export async function registerMcpOAuthClient(input: {
  client_name?: string;
  client_uri?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}) {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "At least one redirect URI is required.",
    );
  }
  input.redirect_uris.forEach(assertValidRedirectUri);
  const grantTypes = resolveSupportedClientValues(
    input.grant_types,
    SUPPORTED_GRANT_TYPES,
  );
  const responseTypes = resolveSupportedClientValues(
    input.response_types,
    SUPPORTED_RESPONSE_TYPES,
  );
  const tokenEndpointAuthMethod = resolveTokenEndpointAuthMethod(
    input.token_endpoint_auth_method,
  );
  if (
    input.client_uri !== undefined &&
    !isHttpsOrLocalhostUrl(input.client_uri)
  ) {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "client_uri must use HTTPS or localhost HTTP.",
    );
  }
  const now = nowIso();
  const client: McpOAuthClient = {
    clientId: `mcp_client_${randomToken(CLIENT_ID_BYTES)}`,
    clientName: input.client_name?.trim() || "MCP Client",
    redirectUris: Array.from(new Set(input.redirect_uris)),
    clientUri: input.client_uri,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod,
    createdAt: now,
    updatedAt: now,
  };
  await getMcpOAuthRepository().writeClient(client);
  return client;
}

export async function getMcpOAuthClient(clientId: string) {
  return getMcpOAuthRepository().getClient(clientId);
}

export async function hasMcpOAuthConsent(params: {
  userId: string;
  clientId: string;
  scopes: McpScope[];
}) {
  const consent = await getMcpOAuthRepository().getConsent(
    params.userId,
    params.clientId,
  );
  if (!consent) return false;
  return hasMcpScopes(parseMcpScopes(consent.scope), params.scopes);
}

export async function grantMcpOAuthConsent(params: {
  userId: string;
  clientId: string;
  scopes: McpScope[];
}) {
  const now = nowIso();
  const existing = await getMcpOAuthRepository().getConsent(
    params.userId,
    params.clientId,
  );
  await getMcpOAuthRepository().writeConsent({
    userId: params.userId,
    clientId: params.clientId,
    scope: formatMcpScope(params.scopes),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export async function issueMcpAuthorizationCode(params: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
}) {
  assertMcpResource(params.resource);
  if (params.codeChallengeMethod !== "S256") {
    throw new McpOAuthError("invalid_request", "PKCE S256 is required.");
  }
  const client = await getMcpOAuthRepository().getClient(params.clientId);
  if (!client) throw new McpOAuthError("invalid_client", "Unknown MCP client.");
  assertClientRedirectUri(client, params.redirectUri);
  const scopes = parseMcpScopes(params.scope);
  const code = `mcp_code_${randomToken(AUTH_CODE_BYTES)}`;
  await getMcpOAuthRepository().writeAuthorizationCode({
    codeHash: hashMcpToken(code),
    clientId: params.clientId,
    userId: params.userId,
    redirectUri: params.redirectUri,
    scope: formatMcpScope(scopes),
    resource: params.resource,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    createdAt: nowIso(),
    expiresAt: epochSeconds() + config.mcp.authorizationCodeTtlSeconds,
  });
  return code;
}

export async function exchangeMcpAuthorizationCode(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
}) {
  assertMcpResource(params.resource);
  assertPkceVerifier(params.codeVerifier);
  const repository = getMcpOAuthRepository();
  const codeHash = hashMcpToken(params.code);
  const code = await repository.consumeAuthorizationCode(codeHash);
  if (!code)
    throw new McpOAuthError("invalid_grant", "Invalid authorization code.");
  if (code.expiresAt <= epochSeconds()) {
    throw new McpOAuthError("invalid_grant", "Authorization code expired.");
  }
  if (
    code.clientId !== params.clientId ||
    code.redirectUri !== params.redirectUri
  ) {
    throw new McpOAuthError("invalid_grant", "Authorization code mismatch.");
  }
  if (createPkceChallenge(params.codeVerifier) !== code.codeChallenge) {
    throw new McpOAuthError("invalid_grant", "Invalid PKCE code verifier.");
  }
  return issueTokenPair({
    clientId: code.clientId,
    userId: code.userId,
    scopes: parseMcpScopes(code.scope),
    resource: code.resource,
  });
}

function assertUsableRefreshToken(
  token: McpOAuthToken | undefined,
  clientId: string,
  now: number,
): asserts token is McpOAuthToken {
  if (!token || token.expiresAt <= now || token.clientId !== clientId) {
    throw new McpOAuthError("invalid_grant", "Invalid refresh token.");
  }
}

const shouldForceScopeChallengeReauthorization = (params: {
  requestedScopes?: McpScope[];
  pairedAccessToken?: McpOAuthToken;
  tokenScopes: McpScope[];
  now: number;
}) => {
  const challengeScopes = getActiveScopeChallenge(
    params.pairedAccessToken,
    params.now,
  );
  if (
    params.requestedScopes ||
    !params.pairedAccessToken ||
    params.pairedAccessToken.expiresAt <= params.now ||
    !challengeScopes ||
    hasMcpScopes(params.tokenScopes, challengeScopes)
  ) {
    return false;
  }
  return true;
};

const assertRefreshScopeConsent = async (params: {
  token: McpOAuthToken;
  tokenScopes: McpScope[];
  requestedScopes?: McpScope[];
}) => {
  if (
    !params.requestedScopes ||
    hasMcpScopes(params.tokenScopes, params.requestedScopes) ||
    (await hasMcpOAuthConsent({
      userId: params.token.userId,
      clientId: params.token.clientId,
      scopes: params.requestedScopes,
    }))
  ) {
    return;
  }
  throw new McpOAuthError(
    "invalid_scope",
    "Requested scope requires user authorization.",
  );
};

export async function refreshMcpAccessToken(params: {
  clientId: string;
  refreshToken: string;
  resource?: string;
  scope?: string;
}) {
  assertMcpResource(params.resource);
  const requestedScopes = params.scope
    ? parseMcpScopes(params.scope)
    : undefined;
  const repository = getMcpOAuthRepository();
  const now = epochSeconds();
  const tokenHash = hashMcpToken(params.refreshToken);
  const token = await repository.getToken("refresh", tokenHash);
  assertUsableRefreshToken(token, params.clientId, now);
  const tokenScopes = parseMcpScopes(token.scope);
  const pairedAccessToken = token.pairedTokenHash
    ? await repository.getToken("access", token.pairedTokenHash)
    : undefined;
  // MCP clients may try refresh before browser reauth during step-up. Without
  // an explicit scope, that would just recreate the challenged live token.
  if (
    shouldForceScopeChallengeReauthorization({
      requestedScopes,
      pairedAccessToken,
      tokenScopes,
      now,
    })
  ) {
    const consumedToken = await repository.consumeToken("refresh", tokenHash);
    assertUsableRefreshToken(consumedToken, params.clientId, now);
    if (consumedToken.pairedTokenHash) {
      await repository.deleteToken("access", consumedToken.pairedTokenHash);
    }
    throw new McpOAuthError(
      "invalid_grant",
      "Refresh token cannot satisfy the pending scope challenge.",
    );
  }
  await assertRefreshScopeConsent({ token, tokenScopes, requestedScopes });
  const consumedToken = await repository.consumeToken("refresh", tokenHash);
  assertUsableRefreshToken(consumedToken, params.clientId, now);
  if (consumedToken.pairedTokenHash) {
    await repository.deleteToken("access", consumedToken.pairedTokenHash);
  }
  return issueTokenPair({
    clientId: consumedToken.clientId,
    userId: consumedToken.userId,
    scopes: requestedScopes ?? tokenScopes,
    resource: consumedToken.resource,
  });
}

export async function markMcpAccessTokenScopeChallenge(
  accessToken: string,
  scopes: McpScope[],
) {
  const repository = getMcpOAuthRepository();
  const now = epochSeconds();
  const token = await repository.getToken("access", hashMcpToken(accessToken));
  if (
    !token ||
    token.expiresAt <= now ||
    token.resource !== getMcpResourceUrl()
  ) {
    return;
  }
  await repository.writeToken({
    ...token,
    scopeChallenge: formatMcpScope(scopes),
    scopeChallengeExpiresAt: Math.min(
      token.expiresAt,
      now + SCOPE_CHALLENGE_TTL_SECONDS,
    ),
  });
}

export async function revokeMcpToken(token: string) {
  const tokenHash = hashMcpToken(token);
  const repository = getMcpOAuthRepository();
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

export async function validateMcpAccessToken(
  token: string,
): Promise<McpAccessTokenInfo | undefined> {
  const record = await getMcpOAuthRepository().getToken(
    "access",
    hashMcpToken(token),
  );
  if (!record) return undefined;
  if (record.expiresAt <= epochSeconds()) return undefined;
  if (record.resource !== getMcpResourceUrl()) return undefined;
  try {
    return {
      clientId: record.clientId,
      userId: record.userId,
      scopes: parseMcpScopes(record.scope),
      resource: record.resource,
      expiresAt: record.expiresAt,
    };
  } catch {
    return undefined;
  }
}
