import crypto from "node:crypto";
import { resetMcpOAuthMemoryRepository } from "../../repositories/mcpOAuthRepository";
import {
  exchangeMcpAuthorizationCode,
  getMcpResourceUrl,
  issueMcpAuthorizationCode,
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

  it("rejects unsupported scopes", () => {
    expect(() => parseMcpScopes("meetings:write")).toThrow(McpOAuthError);
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
