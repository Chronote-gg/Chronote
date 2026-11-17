/** @jest-environment node */
import type { Server } from "node:http";

jest.mock("../src/services/sessionStore", () => ({
  DynamoSessionStore: jest.requireActual("express-session").MemoryStore,
}));
jest.mock("../src/services/guildAccessService", () => ({
  ...jest.requireActual("../src/services/guildAccessService"),
  ensureUserInGuild: jest.fn(async () => true),
  ensureManageGuildWithUserToken: jest.fn(async () => true),
}));
jest.mock("../src/services/unifiedConfigService", () => ({
  ...jest.requireActual("../src/services/unifiedConfigService"),
  resolveConfigSnapshot: jest.fn(async () => ({ values: {} })),
}));
jest.mock("../src/services/meetingSearchService", () => ({
  ...jest.requireActual("../src/services/meetingSearchService"),
  searchMeetingsForUser: jest.fn(async () => ({ meetings: [] })),
}));

import { config } from "../src/services/configService";
import { serveWebApplication } from "./fixtures/webserver";

let server: Server;
const previousMock = config.mock.enabled;
afterEach(async () => {
  config.mock.enabled = previousMock;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.each([true, false])(
  "production tRPC mount accepts POST queries and preserves CSRF and auth, signed in: %s",
  async (signedIn) => {
    config.mock.enabled = signedIn;
    const application = await serveWebApplication();
    server = application.server;
    const { origin } = application;
    const url = `${origin}/trpc/ask.searchMeetings?batch=1`;
    const body = JSON.stringify({
      0: { serverId: "test-server", query: "synthetic private phrase" },
    });
    const headers = { "content-type": "application/json" };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(
      403,
    );
    const tokenResponse = await fetch(`${origin}/api/csrf-token`);
    const { csrfToken } = await tokenResponse.json();
    const cookie = tokenResponse.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, cookie, "x-csrf-token": csrfToken },
      body,
    });
    expect(response.status).toBe(signedIn ? 200 : 401);
    expect(await response.json()).toMatchObject(
      signedIn
        ? [{ result: { data: { meetings: [] } } }]
        : [{ error: { data: { code: "UNAUTHORIZED" } } }],
    );
  },
);
