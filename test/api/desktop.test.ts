/** @jest-environment node */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerDesktopRoutesIfEnabled } from "../../src/api/desktop";
import { registerMockStorageRoutes } from "../../src/api/mockStorage";
import { resetDesktopAuthMemoryRepository } from "../../src/repositories/desktopAuthRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  scope: string;
  user: {
    id: string;
    username: string;
    avatar: string | null;
  };
};

type RecordingIntentResponse = {
  uploadId: string;
  sources: Array<{
    sourceId: string;
    sourceS3Key: string;
    contentType: string;
    uploadToken: string;
    upload: {
      url: string;
      fields: Record<string, string>;
    };
  }>;
};

type RecordingJobResponse = {
  job: {
    uploadId: string;
    ownerUserId: string;
    status: string;
    uploadOrigin?: string;
    title?: string;
    tags?: string[];
    sourceManifest?: Array<{
      sourceId: string;
      kind: string;
      label: string;
      sourceS3Key: string;
      originalFileName?: string;
    }>;
  };
};

const originalMockEnabled = Object.getOwnPropertyDescriptor(
  config.mock,
  "enabled",
);
const originalPublicBaseUrl = Object.getOwnPropertyDescriptor(
  config.mcp,
  "publicBaseUrl",
);
const originalDesktopEnabled = Object.getOwnPropertyDescriptor(
  config.desktop,
  "enabled",
);
const originalDesktopAllowedUserIds = Object.getOwnPropertyDescriptor(
  config.desktop,
  "allowedUserIds",
);

const mockDesktopUser = {
  id: "desktop-user-1",
  username: "Desktop Tester",
  avatar: null,
};

const createServer = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const request = req as typeof req & {
      user?: typeof mockDesktopUser;
      isAuthenticated?: () => boolean;
    };
    request.user = mockDesktopUser;
    request.isAuthenticated = () => true;
    next();
  });
  registerDesktopRoutesIfEnabled(app);
  registerMockStorageRoutes(app);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const closeServer = async (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const readJson = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const expectSuccess = async (response: Response) => {
  if (response.ok) return;
  throw new Error(
    `Expected HTTP success but received ${response.status}: ${await response.text()}`,
  );
};

const createPkceChallenge = (codeVerifier: string) =>
  crypto.createHash("sha256").update(codeVerifier).digest("base64url");

const buildAuthorizeUrl = (baseUrl: string, redirectUri: string) => {
  const codeVerifier = "A".repeat(64);
  const authorizeUrl = new URL(`${baseUrl}/api/desktop/auth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set(
    "code_challenge",
    createPkceChallenge(codeVerifier),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "scope",
    "profile:read personal_uploads:write meetings:read",
  );
  authorizeUrl.searchParams.set("state", "desktop-state");
  return { authorizeUrl, codeVerifier };
};

const authorizeDesktopToken = async (baseUrl: string) => {
  const redirectUri = "http://127.0.0.1:49152/auth/callback";
  const { authorizeUrl, codeVerifier } = buildAuthorizeUrl(
    baseUrl,
    redirectUri,
  );

  const authorizeResponse = await fetch(authorizeUrl, {
    redirect: "manual",
  });
  expect(authorizeResponse.status).toBe(302);
  const callbackUrl = new URL(authorizeResponse.headers.get("location") ?? "");
  expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
  expect(callbackUrl.searchParams.get("state")).toBe("desktop-state");
  expect(callbackUrl.searchParams.get("error")).toBeNull();

  const tokenResponse = await fetch(`${baseUrl}/api/desktop/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: callbackUrl.searchParams.get("code"),
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  await expectSuccess(tokenResponse);
  return readJson<TokenResponse>(tokenResponse);
};

const uploadSource = async (
  source: RecordingIntentResponse["sources"][number],
  body: Buffer,
) => {
  const form = new FormData();
  Object.entries(source.upload.fields).forEach(([name, value]) => {
    form.set(name, value);
  });
  form.set(
    "file",
    new Blob([body], { type: source.contentType }),
    `${source.sourceId}.wav`,
  );

  const response = await fetch(source.upload.url, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(204);
};

describe("desktop API", () => {
  beforeEach(() => {
    resetMockStore();
    resetDesktopAuthMemoryRepository();
    Object.defineProperty(config.mock, "enabled", {
      get: () => true,
      configurable: true,
    });
    Object.defineProperty(config.desktop, "enabled", {
      get: () => true,
      configurable: true,
    });
    Object.defineProperty(config.desktop, "allowedUserIds", {
      get: () => [mockDesktopUser.id],
      configurable: true,
    });
  });

  afterEach(() => {
    resetMockStore();
    resetDesktopAuthMemoryRepository();
    if (originalMockEnabled) {
      Object.defineProperty(config.mock, "enabled", originalMockEnabled);
    }
    if (originalPublicBaseUrl) {
      Object.defineProperty(config.mcp, "publicBaseUrl", originalPublicBaseUrl);
    }
    if (originalDesktopEnabled) {
      Object.defineProperty(config.desktop, "enabled", originalDesktopEnabled);
    }
    if (originalDesktopAllowedUserIds) {
      Object.defineProperty(
        config.desktop,
        "allowedUserIds",
        originalDesktopAllowedUserIds,
      );
    }
  });

  test("does not register desktop routes when the desktop API is disabled", async () => {
    Object.defineProperty(config.desktop, "enabled", {
      get: () => false,
      configurable: true,
    });
    const { server, baseUrl } = createServer();

    try {
      const response = await fetch(`${baseUrl}/api/desktop/auth/scopes`);
      expect(response.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  test("denies desktop authorization outside the beta allowlist", async () => {
    Object.defineProperty(config.desktop, "allowedUserIds", {
      get: () => ["other-user"],
      configurable: true,
    });
    const { server, baseUrl } = createServer();

    try {
      const redirectUri = "http://127.0.0.1:49152/auth/callback";
      const { authorizeUrl } = buildAuthorizeUrl(baseUrl, redirectUri);
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(302);
      const callbackUrl = new URL(response.headers.get("location") ?? "");
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
      expect(callbackUrl.searchParams.get("error")).toBe("access_denied");
      expect(callbackUrl.searchParams.get("code")).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  test("denies recording upload after a user is removed from the beta allowlist", async () => {
    const { server, baseUrl } = createServer();
    Object.defineProperty(config.mcp, "publicBaseUrl", {
      get: () => baseUrl,
      configurable: true,
    });

    try {
      const token = await authorizeDesktopToken(baseUrl);
      Object.defineProperty(config.desktop, "allowedUserIds", {
        get: () => ["other-user"],
        configurable: true,
      });

      const response = await fetch(`${baseUrl}/api/desktop/recordings/intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({
          sources: [
            {
              sourceId: "owner_mic",
              kind: "owner_mic",
              label: "Me",
              contentType: "audio/wav",
              fileSize: 4,
            },
          ],
        }),
      });
      expect(response.status).toBe(403);
      await expect(readJson<{ error: string }>(response)).resolves.toEqual(
        expect.objectContaining({ error: "access_denied" }),
      );
    } finally {
      await closeServer(server);
    }
  });

  test("authorizes, uploads, and completes a multi-source desktop recording", async () => {
    const { server, baseUrl } = createServer();
    Object.defineProperty(config.mcp, "publicBaseUrl", {
      get: () => baseUrl,
      configurable: true,
    });

    try {
      const token = await authorizeDesktopToken(baseUrl);
      expect(token.user).toEqual(mockDesktopUser);
      expect(token.scope.split(" ")).toEqual([
        "profile:read",
        "personal_uploads:write",
        "meetings:read",
      ]);

      const intentResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/intent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.access_token}`,
          },
          body: JSON.stringify({
            sources: [
              {
                sourceId: "owner_mic",
                kind: "owner_mic",
                label: "Me",
                contentType: "audio/wav",
                fileSize: 4,
              },
              {
                sourceId: "system_output",
                kind: "system_output",
                label: "System/Other",
                contentType: "audio/wav",
                fileSize: 6,
              },
            ],
          }),
        },
      );
      await expectSuccess(intentResponse);
      const intent = await readJson<RecordingIntentResponse>(intentResponse);
      expect(intent.sources).toHaveLength(2);

      await uploadSource(intent.sources[0], Buffer.from([0, 1, 2, 3]));
      await uploadSource(intent.sources[1], Buffer.from([4, 5, 6, 7, 8, 9]));

      const completeResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.access_token}`,
          },
          body: JSON.stringify({
            uploadId: intent.uploadId,
            title: "Desktop smoke recording",
            tags: ["desktop", "smoke"],
            sources: intent.sources.map((source) => ({
              sourceId: source.sourceId,
              key: source.sourceS3Key,
              uploadToken: source.uploadToken,
              originalFileName: `${source.sourceId}.wav`,
            })),
          }),
        },
      );
      await expectSuccess(completeResponse);
      const completed = await readJson<RecordingJobResponse>(completeResponse);
      expect(completed.job).toEqual(
        expect.objectContaining({
          uploadId: intent.uploadId,
          ownerUserId: mockDesktopUser.id,
          status: "queued",
          uploadOrigin: "desktop_recording",
          title: "Desktop smoke recording",
          tags: ["desktop", "smoke"],
        }),
      );
      expect(completed.job.sourceManifest).toEqual([
        expect.objectContaining({
          sourceId: "owner_mic",
          kind: "owner_mic",
          label: "Me",
          originalFileName: "owner_mic.wav",
        }),
        expect.objectContaining({
          sourceId: "system_output",
          kind: "system_output",
          label: "System/Other",
          originalFileName: "system_output.wav",
        }),
      ]);

      const statusResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/${intent.uploadId}`,
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
        },
      );
      await expectSuccess(statusResponse);
      const status = await readJson<RecordingJobResponse>(statusResponse);
      expect(status.job.status).toBe("queued");
      expect(status.job.sourceManifest).toHaveLength(2);
    } finally {
      await closeServer(server);
    }
  });
});
