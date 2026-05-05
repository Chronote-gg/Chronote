import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import session from "express-session";
import passport from "passport";
import { doubleCsrf } from "csrf-csrf";
import { Profile, Strategy as DiscordStrategy } from "passport-discord";
import { User } from "discord.js";
import * as trpcExpress from "@trpc/server/adapters/express";
import { registerBillingRoutes } from "./api/billing";
import { registerGuildRoutes } from "./api/guilds";
import { registerLiveMeetingRoutes } from "./api/liveMeetings";
import { config } from "./services/configService";
import { DynamoSessionStore } from "./services/sessionStore";
import { getStripeClient } from "./services/stripeClient";
import { saveGuildInstaller } from "./services/guildInstallerService";
import { metricsMiddleware, metricsRegistry } from "./metrics";
import { appRouter } from "./trpc/router";
import { AuthedProfile, createContext } from "./trpc/context";
import { getMockUser } from "./repositories/mockStore";
import { resolveRedirectTarget } from "./services/oauthRedirectService";
import {
  readOauthRedirectFromRequest,
  stashOauthRedirectFromSession,
} from "./services/oauthRedirectSession";
import { createAuthRateLimiter } from "./services/authRateLimitService";
import {
  buildDiscordAuthProfile,
  ensureDiscordAccessToken,
} from "./services/discordAuthService";

const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 20;
const CSRF_TOKEN_PATH = "/api/csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";

export function setupWebServer() {
  const app = express();
  const PORT = config.server.port;
  type SessionWithRedirect = session.Session & { oauthRedirect?: string };

  const resolveRedirectParam = (req: express.Request) =>
    resolveRedirectTarget(req.query.redirect, config.frontend.siteUrl);

  const storeRedirectInSession = (
    req: express.Request,
    redirect?: string,
  ): SessionWithRedirect | undefined => {
    if (!redirect) return undefined;
    const sessionWithRedirect = req.session as SessionWithRedirect | undefined;
    if (!sessionWithRedirect) return undefined;
    sessionWithRedirect.oauthRedirect = redirect;
    return sessionWithRedirect;
  };

  // Trust first proxy (needed for secure cookies behind ALB/CloudFront)
  app.set("trust proxy", 1);

  if (config.mock.enabled) {
    app.use((req, _res, next) => {
      (req as typeof req & { user?: unknown }).user = getMockUser();
      (req as unknown as { isAuthenticated?: () => boolean }).isAuthenticated =
        () => true;
      next();
    });
  }

  // CORS (allow static frontend domain to call API with credentials)
  app.use(
    cors({
      origin:
        config.frontend.allowedOrigins.length > 0
          ? config.frontend.allowedOrigins
          : undefined,
      credentials: true,
    }),
  );

  // Body parsers
  app.use("/api/billing/webhook", express.raw({ type: "application/json" }));
  app.use(express.json());

  // Metrics middleware (must come before routes)
  app.use(metricsMiddleware);

  // Health check endpoint
  app.get("/health", (_, res) => {
    const healthCheck = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.nodeEnv,
      version: config.server.npmPackageVersion,
    };
    res.status(200).json(healthCheck);
  });

  // Prometheus metrics
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  // Configure session management (Dynamo-backed, swappable later)
  const isLocalhost =
    config.frontend.siteUrl.startsWith("http://localhost") ||
    config.frontend.siteUrl.startsWith("http://127.0.0.1");

  const sessionStore = config.mock.enabled
    ? new session.MemoryStore()
    : new DynamoSessionStore();

  const csrfCookieOptions = {
    httpOnly: true,
    secure: !isLocalhost && config.server.nodeEnv === "production",
    sameSite:
      !isLocalhost && config.frontend.allowedOrigins.length > 0
        ? ("none" as const)
        : ("lax" as const),
    path: "/",
  };

  app.use(
    session({
      store: sessionStore,
      secret: config.server.oauthSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // In dev on localhost we can't set Secure; in prod we should.
        secure: !isLocalhost && config.server.nodeEnv === "production",
        // SameSite=None is required for cross-origin cookies, but Chrome requires Secure.
        // When developing on localhost over http, fall back to lax so cookies are accepted.
        sameSite:
          !isLocalhost && config.frontend.allowedOrigins.length > 0
            ? ("none" as const)
            : ("lax" as const),
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    }),
  );

  app.use(cookieParser());

  const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => config.server.oauthSecret,
    getSessionIdentifier: () => "chronote-web",
    cookieName: isLocalhost
      ? "chronote.csrf-token"
      : "__Host-chronote.csrf-token",
    cookieOptions: csrfCookieOptions,
    getCsrfTokenFromRequest: (req) => req.headers[CSRF_HEADER_NAME],
    skipCsrfProtection: (req) => req.path === "/api/billing/webhook",
  });

  app.get(CSRF_TOKEN_PATH, (req, res) => {
    const csrfToken = generateCsrfToken(req, res);
    res.json({ csrfToken });
  });

  app.use(doubleCsrfProtection);

  const authRateLimiter = createAuthRateLimiter({
    enabled: !config.mock.enabled,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_RATE_LIMIT_MAX,
  });

  if (config.server.oauthEnabled) {
    // Initialize Passport
    app.use(passport.initialize());
    app.use(passport.session());

    // Configure Passport with Discord strategy
    passport.use(
      new DiscordStrategy(
        {
          clientID: config.discord.clientId,
          clientSecret: config.discord.clientSecret,
          callbackURL: config.discord.callbackUrl,
          scope: ["identify", "email", "guilds"],
          state: true,
        },
        (
          accessToken: string,
          refreshToken: string,
          params: { expires_in?: number | string },
          profile: Profile,
          done: (err: unknown, user?: AuthedProfile | false) => void,
        ) => {
          // Preserve access token for API calls (e.g., guild listing)
          const authedProfile = buildDiscordAuthProfile(
            profile as Profile,
            accessToken,
            refreshToken,
            params?.expires_in,
          );
          // Here you can save the profile information to your database if needed
          return done(null, authedProfile);
        },
      ),
    );

    // Serialize and deserialize user
    passport.serializeUser((user, done) => {
      done(null, user);
    });

    passport.deserializeUser((obj, done) => {
      done(null, obj as User);
    });

    const clearDiscordSession = async (req: express.Request) => {
      if (typeof req.logout === "function") {
        await new Promise<void>((resolve) => {
          req.logout(() => resolve());
        });
      }
      const sessionWithPassport = req.session as
        | (typeof req.session & { passport?: { user?: unknown } })
        | undefined;
      if (sessionWithPassport?.passport?.user) {
        sessionWithPassport.passport.user = undefined;
      }
      if (req.session) {
        await new Promise<void>((resolve) => {
          req.session.destroy((err) => {
            if (err) {
              console.error("Failed to destroy session", err);
            }
            resolve();
          });
        });
      }
      (req as typeof req & { user?: unknown }).user = undefined;
    };

    app.use(async (req, _res, next) => {
      if (config.mock.enabled) {
        next();
        return;
      }
      if (!req.isAuthenticated?.()) {
        next();
        return;
      }
      const user = req.user as AuthedProfile;
      const refreshResult = await ensureDiscordAccessToken(user);
      if (refreshResult.shouldLogout) {
        console.warn("Discord refresh token invalid, clearing session", {
          userId: user.id,
          status: refreshResult.error?.status,
          error: refreshResult.error?.error,
        });
        await clearDiscordSession(req);
        next();
        return;
      }
      if (refreshResult.refreshed) {
        const updated = refreshResult.user;
        req.user = updated;
        const sessionWithPassport = req.session as
          | (typeof req.session & { passport?: { user?: unknown } })
          | undefined;
        if (sessionWithPassport?.passport?.user) {
          sessionWithPassport.passport.user = updated;
        }
        if (sessionWithPassport) {
          await new Promise<void>((resolve) => {
            sessionWithPassport.save(() => resolve());
          });
        }
      }
      next();
    });

    // Discord OAuth routes
    app.get(
      "/auth/discord",
      authRateLimiter,
      (req, _res, next) => {
        const redirectParam = resolveRedirectParam(req);
        const sessionWithRedirect = storeRedirectInSession(req, redirectParam);
        if (!sessionWithRedirect) {
          next();
          return;
        }
        sessionWithRedirect.save((err) => {
          if (err) {
            next(err);
            return;
          }
          next();
        });
      },
      passport.authenticate("discord"),
    );

    app.get(
      "/auth/discord/callback",
      authRateLimiter,
      (req, _res, next) => {
        stashOauthRedirectFromSession(req);
        next();
      },
      passport.authenticate("discord", {
        failureRedirect: "/",
      }),
      (req, res) => {
        const guildId = req.query.guild_id as string | undefined;
        const profile = req.user as Profile;
        const sessionRedirect = readOauthRedirectFromRequest(req);
        if (guildId) {
          saveGuildInstaller({
            guildId,
            installerId: profile.id,
            installedAt: new Date().toISOString(),
          }).catch((err) =>
            console.error("Failed to persist installer mapping", err),
          );
        }
        const fallback =
          config.frontend.siteUrl && config.frontend.siteUrl.length > 0
            ? config.frontend.siteUrl
            : "/";
        res.redirect(sessionRedirect || fallback);
      },
    );
  } else {
    app.get("/auth/discord", authRateLimiter, (req, res) => {
      const redirectParam = resolveRedirectParam(req);
      const fallback =
        config.frontend.siteUrl && config.frontend.siteUrl.length > 0
          ? config.frontend.siteUrl
          : "/";
      res.redirect(redirectParam || fallback);
    });
    app.get("/auth/discord/callback", authRateLimiter, (req, res) => {
      const redirectParam = resolveRedirectParam(req);
      const fallback =
        config.frontend.siteUrl && config.frontend.siteUrl.length > 0
          ? config.frontend.siteUrl
          : "/";
      res.redirect(redirectParam || fallback);
    });
  }

  app.get("/logout", (req, res) => {
    const redirectParam = resolveRedirectParam(req);
    const fallback =
      config.frontend.siteUrl && config.frontend.siteUrl.length > 0
        ? config.frontend.siteUrl
        : "/";
    const redirectTarget = redirectParam || fallback;
    const finishLogout = () => {
      res.redirect(redirectTarget);
    };
    if (typeof req.logout === "function") {
      req.logout((err) => {
        if (err) {
          console.error(err);
        }
        finishLogout();
      });
      return;
    }
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          console.error(err);
        }
        finishLogout();
      });
      return;
    }
    finishLogout();
  });

  app.get("/user", (req, res) => {
    if (req.isAuthenticated()) {
      res.json(req.user as Profile);
    } else {
      res.status(401).json({ error: "User not authenticated" });
    }
  });

  // tRPC API
  app.use(
    "/trpc",
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Stripe integration (shared routes live in src/api)
  const stripe = getStripeClient();

  registerBillingRoutes(app, stripe);
  registerGuildRoutes(app);
  registerLiveMeetingRoutes(app);

  app.listen(PORT, () => {
    console.log(`Server is running and listening on port ${PORT}`);
  });
}
