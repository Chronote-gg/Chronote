import crypto from "node:crypto";
import { resetDesktopAuthMemoryRepository } from "../../repositories/desktopAuthRepository";
import {
  exchangeDesktopAuthorizationCode,
  issueDesktopAuthorizationCode,
  parseDesktopScopes,
  refreshDesktopAccessToken,
  revokeDesktopToken,
  validateDesktopAccessToken,
} from "../desktopAuthService";

const codeVerifier = "a".repeat(64);
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");
const redirectUri = "http://127.0.0.1:49152/auth/callback";
const user = {
  id: "user-1",
  username: "Test User",
  avatar: null,
};

describe("desktopAuthService", () => {
  beforeEach(() => {
    resetDesktopAuthMemoryRepository();
  });

  it("exchanges a localhost PKCE authorization code for desktop tokens", async () => {
    const code = await issueDesktopAuthorizationCode({
      user,
      redirectUri,
      scope: "profile:read personal_uploads:write",
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const tokens = await exchangeDesktopAuthorizationCode({
      code,
      redirectUri,
      codeVerifier,
    });

    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("profile:read personal_uploads:write");
    await expect(
      validateDesktopAccessToken(tokens.access_token),
    ).resolves.toMatchObject({
      userId: "user-1",
      username: "Test User",
      scopes: ["profile:read", "personal_uploads:write"],
    });
  });

  it("rejects reused authorization codes", async () => {
    const code = await issueDesktopAuthorizationCode({
      user,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    await exchangeDesktopAuthorizationCode({ code, redirectUri, codeVerifier });

    await expect(
      exchangeDesktopAuthorizationCode({ code, redirectUri, codeVerifier }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rotates refresh tokens and revokes the paired access token", async () => {
    const code = await issueDesktopAuthorizationCode({
      user,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const firstTokens = await exchangeDesktopAuthorizationCode({
      code,
      redirectUri,
      codeVerifier,
    });

    const secondTokens = await refreshDesktopAccessToken({
      refreshToken: firstTokens.refresh_token,
    });

    expect(secondTokens.access_token).not.toBe(firstTokens.access_token);
    await expect(
      validateDesktopAccessToken(firstTokens.access_token),
    ).resolves.toBeUndefined();
    await expect(
      refreshDesktopAccessToken({ refreshToken: firstTokens.refresh_token }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("revokes access tokens with their paired refresh tokens", async () => {
    const code = await issueDesktopAuthorizationCode({
      user,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const tokens = await exchangeDesktopAuthorizationCode({
      code,
      redirectUri,
      codeVerifier,
    });

    await revokeDesktopToken(tokens.access_token);

    await expect(
      validateDesktopAccessToken(tokens.access_token),
    ).resolves.toBeUndefined();
    await expect(
      refreshDesktopAccessToken({ refreshToken: tokens.refresh_token }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects unsupported scopes", () => {
    expect(() => parseDesktopScopes("profile:read admin:write")).toThrow(
      "Unsupported desktop scope.",
    );
  });
});
