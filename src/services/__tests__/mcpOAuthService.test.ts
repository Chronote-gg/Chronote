import crypto from "node:crypto";
import {
  getMcpOAuthRepository,
  resetMcpOAuthMemoryRepository,
} from "../../repositories/mcpOAuthRepository";
import {
  buildMcpBearerChallenge,
  exchangeMcpAuthorizationCode,
  getMcpResourceUrl,
  grantMcpOAuthConsent,
  hashMcpToken,
  issueMcpAuthorizationCode,
  markMcpAccessTokenScopeChallenge,
  McpOAuthError,
  parseMcpScopes,
  refreshMcpAccessToken,
  registerMcpOAuthClient,
  revokeMcpToken,
  validateMcpAccessToken,
} from "../mcpOAuthService";

const codeVerifier = "a".repeat(64);
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");
const redirectUri = "http://localhost:8787/oauth/callback";

const expireAccessToken = async (accessToken: string) => {
  const repository = getMcpOAuthRepository();
  const record = await repository.getToken("access", hashMcpToken(accessToken));
  if (!record) throw new Error("Expected access token record.");
  await repository.writeToken({ ...record, expiresAt: 1 });
};

describe("mcpOAuthService", () => {
  beforeEach(() => {
    resetMcpOAuthMemoryRepository();
  });

  it("exchanges a PKCE authorization code for a resource-bound access token", async () => {
    const client = await registerMcpOAuthClient({
      client_name: "Test MCP Client",
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      scope: "meetings:read transcripts:read",
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const tokenResponse = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.scope).toBe("meetings:read transcripts:read");

    const tokenInfo = await validateMcpAccessToken(tokenResponse.access_token);
    expect(tokenInfo).toMatchObject({
      clientId: client.clientId,
      userId: "user-1",
      scopes: ["meetings:read", "transcripts:read"],
      resource: getMcpResourceUrl(),
    });
  });

  it("rejects reused authorization codes", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    await expect(
      exchangeMcpAuthorizationCode({
        clientId: client.clientId,
        code,
        redirectUri,
        codeVerifier,
        resource: getMcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("allows only one concurrent authorization code exchange", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const results = await Promise.allSettled([
      exchangeMcpAuthorizationCode({
        clientId: client.clientId,
        code,
        redirectUri,
        codeVerifier,
        resource: getMcpResourceUrl(),
      }),
      exchangeMcpAuthorizationCode({
        clientId: client.clientId,
        code,
        redirectUri,
        codeVerifier,
        resource: getMcpResourceUrl(),
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rotates refresh tokens and revokes access tokens", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const firstTokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });
    await expireAccessToken(firstTokens.access_token);

    const secondTokens = await refreshMcpAccessToken({
      clientId: client.clientId,
      refreshToken: firstTokens.refresh_token,
      resource: getMcpResourceUrl(),
    });

    expect(secondTokens.access_token).not.toBe(firstTokens.access_token);
    await expect(
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: firstTokens.refresh_token,
        resource: getMcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    await revokeMcpToken(secondTokens.access_token);
    await expect(
      validateMcpAccessToken(secondTokens.access_token),
    ).resolves.toBeUndefined();
    await expect(
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: secondTokens.refresh_token,
        resource: getMcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("revokes access tokens paired with submitted refresh tokens", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    await revokeMcpToken(tokens.refresh_token);

    await expect(
      validateMcpAccessToken(tokens.access_token),
    ).resolves.toBeUndefined();
  });

  it("allows only one concurrent refresh token rotation", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const firstTokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });
    await expireAccessToken(firstTokens.access_token);

    const results = await Promise.allSettled([
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: firstTokens.refresh_token,
        resource: getMcpResourceUrl(),
      }),
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: firstTokens.refresh_token,
        resource: getMcpResourceUrl(),
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rotates scope-less refresh while the paired access token is still valid", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    const refreshedTokens = await refreshMcpAccessToken({
      clientId: client.clientId,
      refreshToken: tokens.refresh_token,
      resource: getMcpResourceUrl(),
    });

    await expect(
      validateMcpAccessToken(tokens.access_token),
    ).resolves.toBeUndefined();
    await expect(
      validateMcpAccessToken(refreshedTokens.access_token),
    ).resolves.toMatchObject({ scopes: ["meetings:read"] });
  });

  it("requires reauthorization for scope-less refresh after a live scope challenge", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    await markMcpAccessTokenScopeChallenge(tokens.access_token, [
      "meetings:read",
      "meetings:start",
    ]);

    await expect(
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: tokens.refresh_token,
        resource: getMcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      validateMcpAccessToken(tokens.access_token),
    ).resolves.toBeUndefined();
  });

  it("refreshes with requested scopes after user consent", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });
    await grantMcpOAuthConsent({
      userId: "user-1",
      clientId: client.clientId,
      scopes: ["meetings:read", "meetings:start"],
    });

    const refreshedTokens = await refreshMcpAccessToken({
      clientId: client.clientId,
      refreshToken: tokens.refresh_token,
      resource: getMcpResourceUrl(),
      scope: "meetings:read meetings:start",
    });

    expect(refreshedTokens.scope).toBe("meetings:read meetings:start");
    await expect(
      validateMcpAccessToken(refreshedTokens.access_token),
    ).resolves.toMatchObject({
      scopes: ["meetings:read", "meetings:start"],
    });
  });

  it("rejects requested refresh scopes without user consent", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeMcpAuthorizationCode({
      clientId: client.clientId,
      code,
      redirectUri,
      codeVerifier,
      resource: getMcpResourceUrl(),
    });

    await expect(
      refreshMcpAccessToken({
        clientId: client.clientId,
        refreshToken: tokens.refresh_token,
        resource: getMcpResourceUrl(),
        scope: "meetings:read meetings:start",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      validateMcpAccessToken(tokens.access_token),
    ).resolves.toMatchObject({ scopes: ["meetings:read"] });

    const refreshedTokens = await refreshMcpAccessToken({
      clientId: client.clientId,
      refreshToken: tokens.refresh_token,
      resource: getMcpResourceUrl(),
    });
    expect(refreshedTokens.scope).toBe("meetings:read");
  });

  it("rejects unsupported scopes", () => {
    expect(() => parseMcpScopes("meetings:write")).toThrow(McpOAuthError);
  });

  it("builds RFC 9728 bearer challenges with step-up scope details", () => {
    const challenge = buildMcpBearerChallenge({
      error: "insufficient_scope",
      errorDescription: 'Need "start" permission.',
      scope: "meetings:read meetings:start",
    });

    expect(challenge).toBe(
      'Bearer resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Need \\"start\\" permission.", scope="meetings:read meetings:start"',
    );
  });

  it("omits scope from structured bearer challenges when not provided", () => {
    const challenge = buildMcpBearerChallenge({ error: "invalid_token" });

    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).not.toContain("scope=");
  });

  it("rejects unsupported dynamic client registration grant types", async () => {
    await expect(
      registerMcpOAuthClient({
        redirect_uris: [redirectUri],
        grant_types: ["implicit"],
      }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("rejects unsupported dynamic client registration response types", async () => {
    await expect(
      registerMcpOAuthClient({
        redirect_uris: [redirectUri],
        response_types: ["token"],
      }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("rejects unsupported dynamic client registration token auth methods", async () => {
    await expect(
      registerMcpOAuthClient({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "client_secret_post",
      }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("rejects invalid dynamic client registration client URIs", async () => {
    await expect(
      registerMcpOAuthClient({
        redirect_uris: [redirectUri],
        client_uri: "not a url",
      }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("treats corrupted stored access token scopes as invalid tokens", async () => {
    const accessToken = "mcp_at_corrupt_scope";
    await getMcpOAuthRepository().writeToken({
      tokenHash: hashMcpToken(accessToken),
      tokenType: "access",
      clientId: "client-1",
      userId: "user-1",
      scope: "meetings:write",
      resource: getMcpResourceUrl(),
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(validateMcpAccessToken(accessToken)).resolves.toBeUndefined();
  });

  it("rejects PKCE verifiers outside the RFC 7636 character set", async () => {
    const client = await registerMcpOAuthClient({
      redirect_uris: [redirectUri],
    });
    const invalidVerifier = `${"a".repeat(63)} `;
    const code = await issueMcpAuthorizationCode({
      clientId: client.clientId,
      userId: "user-1",
      redirectUri,
      resource: getMcpResourceUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    await expect(
      exchangeMcpAuthorizationCode({
        clientId: client.clientId,
        code,
        redirectUri,
        codeVerifier: invalidVerifier,
        resource: getMcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
