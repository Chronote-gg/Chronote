/** @jest-environment node */
import express from "express";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import passport from "passport";
import OAuth2Strategy from "passport-oauth2";
import type { AddressInfo } from "net";
import {
  discordCallbackAuthentication,
  resolveDiscordCallbackRedirect,
} from "../../src/services/discordInstallAuth";
import {
  discordInstallStateStore,
  DISCORD_INSTALL_SESSION_KEY,
  INSTALL_FLOW_TTL_MS,
} from "../../src/services/discordInstallStateStore";
import {
  parseInstallAttribution,
  readInstallAttributionFromRequest,
  setInstallAttributionOnRequest,
} from "../../src/services/installAttributionService";

// Real OAuth2 state validation, token exchange dispatch and Passport session
// regeneration. Only Discord's network token endpoint is replaced.
class TestDiscordStrategy extends OAuth2Strategy {
  constructor(install: boolean) {
    super(
      {
        authorizationURL: "https://discord.com/oauth2/authorize",
        tokenURL: "https://discord.com/api/oauth2/token",
        clientID: "fixture-client",
        clientSecret: "fixture-secret",
        callbackURL: "https://api.chronote.gg/callback",
        state: true,
        ...(install ? { store: discordInstallStateStore } : {}),
      },
      (_accessToken, _refreshToken, _profile, done) =>
        done(null, {
          id: "installer",
          accessToken: "transient-token",
          refreshToken: "transient-refresh",
        }),
    );
    this._oauth2.getOAuthAccessToken = (_code, _params, done) =>
      done(null, "transient-token", "transient-refresh", {});
  }
}

async function createFixture() {
  const auth = new passport.Passport();
  const serialized = jest.fn(
    (user: Express.User, done: (error: null, user: Express.User) => void) =>
      done(null, user),
  );
  auth.serializeUser(serialized);
  auth.deserializeUser((user: Express.User, done) => done(null, user));
  auth.use("discord", new TestDiscordStrategy(false));
  auth.use("discord-install", new TestDiscordStrategy(true));
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
  app.use(
    session({
      secret: "test-only-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true, httpOnly: true },
    }),
  );
  app.use(auth.initialize());
  app.use(auth.session());
  app.get("/session", (req, res) => {
    Object.assign(req.session, {
      oauthRedirect: "https://chronote.gg/library",
      ...(req.query.mcp
        ? { mcpAuthorizeRedirect: "/api/mcp/oauth/authorize?fixture=true" }
        : {}),
      ...(req.query.signedIn
        ? { passport: { user: { id: "existing-user" } } }
        : {}),
    });
    res.json({ sessionId: req.sessionID });
  });
  app.get("/begin", (req, res, next) => {
    setInstallAttributionOnRequest(req, parseInstallAttribution(req.query));
    auth.authenticate("discord-install", { session: false })(req, res, next);
  });
  app.get("/portal-begin", auth.authenticate("discord"));
  app.get(
    "/callback",
    discordCallbackAuthentication(auth, "https://chronote.gg"),
    (req, res) =>
      res.json({
        redirect: resolveDiscordCallbackRedirect(
          req,
          res,
          "https://chronote.gg",
        ),
        user: req.user,
        stored: req.session,
        sessionId: req.sessionID,
        installerId: res.locals.discordInstallerId,
        attribution: readInstallAttributionFromRequest(req),
      }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    serialized,
    get: (path: string, cookie = "") =>
      fetch(`${origin}${path}`, {
        redirect: "manual",
        headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
      }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
const cookieFrom = (response: Response) =>
  response.headers.get("set-cookie")?.split(";")[0] ?? "";
const stateFrom = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("state")!;
const callbackPath = (state: string, denied = false) =>
  `/callback?state=${encodeURIComponent(state)}&${denied ? "error=access_denied" : "code=fixture"}`;

async function runCallback(
  options: {
    install?: boolean;
    signedIn?: boolean;
    dnt?: boolean;
    state?: string;
    denied?: boolean;
    mcp?: boolean;
  } = {},
) {
  const fixture = await createFixture();
  try {
    const seed = await fixture.get(
      `/session?${options.signedIn ? "signedIn=1&" : ""}${options.mcp ? "mcp=1" : ""}`,
    );
    let cookie = cookieFrom(seed);
    const begin = await fixture.get(
      options.install
        ? `/begin?${options.dnt ? "dnt=1" : "source=direct"}`
        : "/portal-begin",
      cookie,
    );
    cookie = cookieFrom(begin) || cookie;
    const response = await fixture.get(
      callbackPath(options.state ?? stateFrom(begin), options.denied),
      cookie,
    );
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: response.status === 200 ? await response.json() : undefined,
      serialized: fixture.serialized,
    };
  } finally {
    await fixture.close();
  }
}

test.each([false, true])(
  "install callback never creates a portal login, DNT=%s",
  async (dnt) => {
    const result = await runCallback({ install: true, dnt });
    expect(result.status).toBe(200);
    expect(result.body.installerId).toBe("installer");
    expect(result.body.redirect).toBe("https://chronote.gg/join");
    expect(result.body.user).toBeUndefined();
    expect(result.body.stored.passport).toBeUndefined();
    expect(result.body.stored[DISCORD_INSTALL_SESSION_KEY]).toEqual(
      expect.any(String),
    );
    expect(result.body.stored.installAttribution).toBeUndefined();
    expect(result.body.attribution?.source).toBe(dnt ? undefined : "direct");
    expect(JSON.stringify(result.body)).not.toContain("transient-");
    expect(result.serialized).not.toHaveBeenCalled();
  },
);
test("install preserves an existing portal identity", async () => {
  const result = await runCallback({ install: true, signedIn: true });
  expect(result.body.user).toEqual({ id: "existing-user" });
  expect(result.body.stored.passport.user).toEqual({ id: "existing-user" });
  expect(result.body.stored.oauthRedirect).toBe("https://chronote.gg/library");
  expect(result.serialized).not.toHaveBeenCalled();
});
test("normal portal callback still serializes its authenticated profile", async () => {
  const result = await runCallback();
  expect(result.body.user.id).toBe("installer");
  expect(result.serialized).toHaveBeenCalledTimes(1);
});
test.each([{ state: "install.invalid" }, { denied: true }])(
  "failed install never logs in: %j",
  async (failure) => {
    const result = await runCallback({ install: true, ...failure });
    expect(result.status).toBe(302);
    expect(result.location).toBe("https://chronote.gg");
    expect(result.serialized).not.toHaveBeenCalled();
  },
);
test.each([false, true])(
  "callback preserves MCP intent on install and consumes it on portal login, install=%s",
  async (install) => {
    const result = await runCallback({ install, mcp: true });
    expect(result.body.redirect).toBe(
      install
        ? "https://chronote.gg/join"
        : "/api/mcp/oauth/authorize?fixture=true",
    );
    expect(result.body.stored.mcpAuthorizeRedirect).toBe(
      install ? "/api/mcp/oauth/authorize?fixture=true" : undefined,
    );
  },
);

test("parallel install flows retain their own attribution and DNT and reject replay", async () => {
  const fixture = await createFixture();
  try {
    const cookie = cookieFrom(await fixture.get("/session"));
    const [a, b] = await Promise.all([
      fixture.get("/begin?source=github", cookie),
      fixture.get("/begin?dnt=1", cookie),
    ]);
    const [resultA, resultB] = await Promise.all([
      fixture.get(callbackPath(stateFrom(a)), cookie),
      fixture.get(callbackPath(stateFrom(b)), cookie),
    ]);
    expect((await resultA.json()).attribution.source).toBe("github");
    expect((await resultB.json()).attribution).toBeUndefined();
    const replay = await fixture.get(callbackPath(stateFrom(a)), cookie);
    expect(replay.status).toBe(302);
    expect(fixture.serialized).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

test("portal login regeneration preserves already-pending install flows", async () => {
  const fixture = await createFixture();
  try {
    const seed = await fixture.get("/session");
    let cookie = cookieFrom(seed);
    const oldSession = (await seed.json()).sessionId;
    const install = await fixture.get("/begin?source=github", cookie);
    const portal = await fixture.get("/portal-begin", cookie);
    const login = await fixture.get(callbackPath(stateFrom(portal)), cookie);
    cookie = cookieFrom(login) || cookie;
    expect((await login.json()).sessionId).not.toBe(oldSession);
    const result = await fixture.get(callbackPath(stateFrom(install)), cookie);
    const body = await result.json();
    expect(body.installerId).toBe("installer");
    expect(body.attribution.source).toBe("github");
    expect(body.user.id).toBe("installer");
  } finally {
    await fixture.close();
  }
});

test("expired install cannot authenticate as a portal login", async () => {
  const fixture = await createFixture();
  try {
    const cookie = cookieFrom(await fixture.get("/session"));
    const install = await fixture.get("/begin", cookie);
    const now = Date.now();
    const time = jest
      .spyOn(Date, "now")
      .mockReturnValue(now + INSTALL_FLOW_TTL_MS + 1000);
    try {
      const result = await fixture.get(
        callbackPath(stateFrom(install)),
        cookie,
      );
      expect(result.status).toBe(302);
      expect(fixture.serialized).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  } finally {
    await fixture.close();
  }
});

test("provider denial consumes only the cancelled flow", async () => {
  const fixture = await createFixture();
  try {
    const cookie = cookieFrom(await fixture.get("/session"));
    const a = await fixture.get("/begin?source=github", cookie);
    const b = await fixture.get("/begin?source=reddit", cookie);
    const denied = await fixture.get(callbackPath(stateFrom(a), true), cookie);
    expect(denied.headers.get("location")).toBe("https://chronote.gg");
    const success = await fixture.get(callbackPath(stateFrom(b)), cookie);
    expect((await success.json()).attribution.source).toBe("reddit");
    const replay = await fixture.get(callbackPath(stateFrom(a)), cookie);
    expect(replay.status).toBe(302);
    expect(fixture.serialized).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
