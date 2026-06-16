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

type RecordingSessionResponse = {
  uploadId: string;
  sources: Array<{
    sourceId: string;
    kind: string;
    label: string;
  }>;
};

type RecordingSegmentIntentResponse = {
  segment: {
    sourceId: string;
    sequence: number;
    sourceS3Key: string;
    contentType: string;
  };
  uploadRequired: boolean;
  uploadToken?: string;
  upload?: {
    url: string;
    fields: Record<string, string>;
  };
};

type RecordingJobResponse = {
  job: {
    uploadId: string;
    ownerUserId: string;
    status: string;
    uploadOrigin?: string;
    title?: string;
    tags?: string[];
    segmentCount?: number;
    uploadedSegmentCount?: number;
    processedSegmentCount?: number;
    sourceManifest?: Array<{
      sourceId: string;
      kind: string;
      label: string;
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

const createServer = (options: { authenticated?: boolean } = {}) => {
  const authenticated = options.authenticated ?? true;
  const session: {
    oauthRedirect?: string;
    save: (callback: (error?: Error) => void) => void;
  } = {
    save: (callback) => callback(),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const request = req as typeof req & {
      session?: typeof session;
      user?: typeof mockDesktopUser;
      isAuthenticated?: () => boolean;
    };
    request.session = session;
    if (authenticated) request.user = mockDesktopUser;
    request.isAuthenticated = () => authenticated;
    next();
  });
  registerDesktopRoutesIfEnabled(app);
  registerMockStorageRoutes(app);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, session };
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

const uploadSegment = async (
  intent: RecordingSegmentIntentResponse,
  body: Buffer,
) => {
  expect(intent.upload).toBeDefined();
  const form = new FormData();
  Object.entries(intent.upload!.fields).forEach(([name, value]) => {
    form.set(name, value);
  });
  form.set(
    "file",
    new Blob([body], { type: intent.segment.contentType }),
    `${intent.segment.sourceId}.wav`,
  );

  const response = await fetch(intent.upload!.url, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(204);
};

const checksumSha256 = (body: Buffer) =>
  crypto.createHash("sha256").update(body).digest("hex");

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

  test("stores unauthenticated desktop authorization redirects as relative paths", async () => {
    const { server, baseUrl, session } = createServer({ authenticated: false });

    try {
      const redirectUri = "http://127.0.0.1:49152/auth/callback";
      const { authorizeUrl } = buildAuthorizeUrl(baseUrl, redirectUri);
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/discord");
      expect(session.oauthRedirect).toBe(
        `${authorizeUrl.pathname}${authorizeUrl.search}`,
      );
      expect(session.oauthRedirect).not.toContain(baseUrl);
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

      const response = await fetch(
        `${baseUrl}/api/desktop/recordings/session`,
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
              },
            ],
          }),
        },
      );
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

      const sessionResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/session`,
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
              },
              {
                sourceId: "system_output",
                kind: "system_output",
                label: "System/Other",
              },
            ],
          }),
        },
      );
      await expectSuccess(sessionResponse);
      const session = await readJson<RecordingSessionResponse>(sessionResponse);
      expect(session.sources).toHaveLength(2);

      const ownerBody = Buffer.from([0, 1, 2, 3]);
      const systemBody = Buffer.from([4, 5, 6, 7, 8, 9]);
      const ownerIntentResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/segment-intent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.access_token}`,
          },
          body: JSON.stringify({
            uploadId: session.uploadId,
            sourceId: "owner_mic",
            sequence: 0,
            contentType: "audio/wav",
            fileSize: ownerBody.byteLength,
            checksumSha256: checksumSha256(ownerBody),
            durationMillis: 1000,
            startedAt: "2026-06-15T00:00:00.000Z",
            endedAt: "2026-06-15T00:00:01.000Z",
            originalFileName: "owner_mic.wav",
          }),
        },
      );
      await expectSuccess(ownerIntentResponse);
      const ownerIntent =
        await readJson<RecordingSegmentIntentResponse>(ownerIntentResponse);
      const systemIntentResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/segment-intent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.access_token}`,
          },
          body: JSON.stringify({
            uploadId: session.uploadId,
            sourceId: "system_output",
            sequence: 0,
            contentType: "audio/wav",
            fileSize: systemBody.byteLength,
            checksumSha256: checksumSha256(systemBody),
            durationMillis: 1000,
            startedAt: "2026-06-15T00:00:00.000Z",
            endedAt: "2026-06-15T00:00:01.000Z",
            originalFileName: "system_output.wav",
          }),
        },
      );
      await expectSuccess(systemIntentResponse);
      const systemIntent =
        await readJson<RecordingSegmentIntentResponse>(systemIntentResponse);

      await uploadSegment(ownerIntent, ownerBody);
      await uploadSegment(systemIntent, systemBody);

      for (const intent of [ownerIntent, systemIntent]) {
        const response = await fetch(
          `${baseUrl}/api/desktop/recordings/segment-complete`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token.access_token}`,
            },
            body: JSON.stringify({
              uploadId: session.uploadId,
              sourceId: intent.segment.sourceId,
              sequence: intent.segment.sequence,
              key: intent.segment.sourceS3Key,
              uploadToken: intent.uploadToken,
            }),
          },
        );
        await expectSuccess(response);
      }

      const submitResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/submit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token.access_token}`,
          },
          body: JSON.stringify({
            uploadId: session.uploadId,
            title: "Desktop smoke recording",
            tags: ["desktop", "smoke"],
          }),
        },
      );
      await expectSuccess(submitResponse);
      const completed = await readJson<RecordingJobResponse>(submitResponse);
      expect(completed.job).toEqual(
        expect.objectContaining({
          uploadId: session.uploadId,
          ownerUserId: mockDesktopUser.id,
          status: "queued",
          uploadOrigin: "desktop_recording",
          title: "Desktop smoke recording",
          tags: ["desktop", "smoke"],
          segmentCount: 2,
          uploadedSegmentCount: 2,
          processedSegmentCount: 0,
        }),
      );
      expect(completed.job.sourceManifest).toEqual([
        expect.objectContaining({
          sourceId: "owner_mic",
          kind: "owner_mic",
          label: "Me",
        }),
        expect.objectContaining({
          sourceId: "system_output",
          kind: "system_output",
          label: "System/Other",
        }),
      ]);

      const statusResponse = await fetch(
        `${baseUrl}/api/desktop/recordings/${session.uploadId}`,
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

  test("rejects duplicate source IDs when creating a desktop recording session", async () => {
    const { server, baseUrl } = createServer();
    Object.defineProperty(config.mcp, "publicBaseUrl", {
      get: () => baseUrl,
      configurable: true,
    });

    try {
      const token = await authorizeDesktopToken(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/desktop/recordings/session`,
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
              },
              {
                sourceId: "owner_mic",
                kind: "owner_mic",
              },
            ],
          }),
        },
      );
      expect(response.status).toBe(400);
      await expect(readJson<{ error: string }>(response)).resolves.toEqual(
        expect.objectContaining({ error: "invalid_request" }),
      );
    } finally {
      await closeServer(server);
    }
  });
});
