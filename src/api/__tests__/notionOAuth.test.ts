import { jest } from "@jest/globals";
import type { Express, RequestHandler } from "express";
import { registerNotionOAuthRoutes } from "../notionOAuth";
import { saveNotionConnectionFromCode } from "../../services/notionService";

jest.mock("../../services/configService", () => ({
  config: {
    frontend: { siteUrl: "http://localhost:5173" },
    notion: {
      enabled: true,
      clientId: "notion-client-id",
      redirectUri: "http://localhost:3001/api/notion/callback",
    },
    mock: { enabled: true },
  },
}));

jest.mock("../../services/oauthRedirectService", () => ({
  resolveRedirectTarget: jest.fn((target: unknown, fallback: string) =>
    typeof target === "string" && target.startsWith("http://localhost:5173")
      ? target
      : fallback,
  ),
}));

jest.mock("../../services/notionService", () => ({
  buildNotionAuthorizationUrl: jest.fn(
    (state: string) =>
      `https://api.notion.com/v1/oauth/authorize?state=${state}`,
  ),
  saveNotionConnectionFromCode: jest.fn(),
}));

type CapturedRoutes = {
  connect: RequestHandler;
  callback: RequestHandler;
};

type MockSession = {
  notionOAuth?: {
    state: string;
    returnTo: string;
    createdAt: number;
  };
  save: (callback: (err?: Error) => void) => void;
};

const captureRoutes = () => {
  const handlers = new Map<string, RequestHandler>();
  const app = {
    get: jest.fn((path: string, ...routeHandlers: RequestHandler[]) => {
      const handler = routeHandlers[routeHandlers.length - 1];
      if (!handler) throw new Error(`Route ${path} is missing a handler.`);
      handlers.set(path, handler);
    }),
  };
  registerNotionOAuthRoutes(app as unknown as Express);
  const connect = handlers.get("/api/notion/connect");
  const callback = handlers.get("/api/notion/callback");
  if (!connect || !callback) throw new Error("Notion OAuth routes missing.");
  return { connect, callback } satisfies CapturedRoutes;
};

const createResponse = () => ({
  statusCode: 200,
  redirectUrl: "",
  jsonBody: undefined as unknown,
  redirect: jest.fn(function redirect(
    this: { redirectUrl: string },
    url: string,
  ) {
    this.redirectUrl = url;
    return this;
  }),
  status: jest.fn(function status(this: { statusCode: number }, code: number) {
    this.statusCode = code;
    return this;
  }),
  json: jest.fn(function json(this: { jsonBody: unknown }, body: unknown) {
    this.jsonBody = body;
    return this;
  }),
});

const createSession = (): MockSession => ({
  save: (callback) => callback(),
});

describe("Notion OAuth routes", () => {
  beforeEach(() => {
    jest.mocked(saveNotionConnectionFromCode).mockResolvedValue({} as never);
  });

  it("stores OAuth state before redirecting to Notion", async () => {
    const { connect } = captureRoutes();
    const session = createSession();
    const response = createResponse();

    await connect(
      {
        query: { redirect: "http://localhost:5173/meetings/meeting-1" },
        originalUrl: "/api/notion/connect",
        session,
        isAuthenticated: () => true,
      } as never,
      response as never,
      jest.fn(),
    );

    expect(session.notionOAuth?.state).toHaveLength(43);
    expect(session.notionOAuth?.returnTo).toBe(
      "http://localhost:5173/meetings/meeting-1",
    );
    expect(response.redirectUrl).toContain(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(response.redirectUrl).toContain(
      `state=${session.notionOAuth?.state}`,
    );
  });

  it("rejects callbacks with invalid state", async () => {
    const { callback } = captureRoutes();
    const session = createSession();
    session.notionOAuth = {
      state: "expected-state",
      returnTo: "http://localhost:5173/library",
      createdAt: Date.now(),
    };
    const response = createResponse();

    await callback(
      {
        query: { state: "wrong-state", code: "oauth-code" },
        session,
        isAuthenticated: () => true,
      } as never,
      response as never,
      jest.fn(),
    );

    expect(saveNotionConnectionFromCode).not.toHaveBeenCalled();
    expect(response.redirectUrl).toBe(
      "http://localhost:5173/library?notion_error=invalid_state",
    );
  });

  it("saves a Notion connection after a valid callback", async () => {
    const { callback } = captureRoutes();
    const session = createSession();
    session.notionOAuth = {
      state: "expected-state",
      returnTo: "http://localhost:5173/library",
      createdAt: Date.now(),
    };
    const response = createResponse();

    await callback(
      {
        query: { state: "expected-state", code: "oauth-code" },
        session,
        user: { id: "user-1" },
        isAuthenticated: () => true,
      } as never,
      response as never,
      jest.fn(),
    );

    expect(saveNotionConnectionFromCode).toHaveBeenCalledWith({
      userId: "user-1",
      code: "oauth-code",
    });
    expect(session.notionOAuth).toBeUndefined();
    expect(response.redirectUrl).toBe(
      "http://localhost:5173/library?notion_connected=1",
    );
  });
});
