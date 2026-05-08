import crypto from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import type { Profile } from "passport-discord";
import type { Session } from "express-session";
import { config } from "../services/configService";
import { createAuthRateLimiter } from "../services/authRateLimitService";
import { resolveRedirectTarget } from "../services/oauthRedirectService";
import {
  buildNotionAuthorizationUrl,
  saveNotionConnectionFromCode,
} from "../services/notionService";

type NotionOAuthSession = Session & {
  notionOAuth?: {
    state: string;
    returnTo: string;
    createdAt: number;
  };
};

const STATE_BYTES = 32;
const STATE_TTL_MS = 10 * 60 * 1000;
const NOTION_OAUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const NOTION_OAUTH_RATE_LIMIT_MAX = 20;

const getSession = (req: Request) =>
  req.session as NotionOAuthSession | undefined;

const getFallbackRedirect = () => config.frontend.siteUrl;

const resolveReturnTo = (req: Request) =>
  resolveRedirectTarget(req.query.redirect, config.frontend.siteUrl) ??
  getFallbackRedirect();

const appendQueryParam = (url: string, key: string, value: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
};

const isAuthenticated = (req: Request) =>
  typeof req.isAuthenticated === "function" && req.isAuthenticated();

const createNotionOAuthRateLimiter = () =>
  createAuthRateLimiter({
    enabled: !config.mock.enabled,
    windowMs: NOTION_OAUTH_RATE_LIMIT_WINDOW_MS,
    limit: NOTION_OAUTH_RATE_LIMIT_MAX,
  });

export function registerNotionOAuthRoutes(
  app: Express,
  rateLimiter: RequestHandler = createNotionOAuthRateLimiter(),
) {
  app.get("/api/notion/connect", rateLimiter, (req, res, next) => {
    if (!config.notion.enabled) {
      res.redirect(
        appendQueryParam(
          resolveReturnTo(req),
          "notion_error",
          "not_configured",
        ),
      );
      return;
    }
    if (!isAuthenticated(req)) {
      res.redirect(
        `/auth/discord?redirect=${encodeURIComponent(req.originalUrl)}`,
      );
      return;
    }

    const session = getSession(req);
    if (!session) {
      res.status(500).json({ error: "Session unavailable" });
      return;
    }

    const state = crypto.randomBytes(STATE_BYTES).toString("base64url");
    session.notionOAuth = {
      state,
      returnTo: resolveReturnTo(req),
      createdAt: Date.now(),
    };
    session.save((err) => {
      if (err) {
        next(err);
        return;
      }
      res.redirect(buildNotionAuthorizationUrl(state));
    });
  });

  app.get("/api/notion/callback", rateLimiter, async (req, res, next) => {
    const session = getSession(req);
    const stored = session?.notionOAuth;
    const returnTo = stored?.returnTo ?? getFallbackRedirect();

    try {
      delete session?.notionOAuth;
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const expired = !stored || Date.now() - stored.createdAt > STATE_TTL_MS;
      if (expired || !state || state !== stored?.state) {
        res.redirect(
          appendQueryParam(returnTo, "notion_error", "invalid_state"),
        );
        return;
      }
      if (typeof req.query.error === "string") {
        res.redirect(
          appendQueryParam(returnTo, "notion_error", req.query.error),
        );
        return;
      }
      if (!code || !isAuthenticated(req)) {
        res.redirect(
          appendQueryParam(returnTo, "notion_error", "missing_code"),
        );
        return;
      }

      const profile = req.user as Profile;
      await saveNotionConnectionFromCode({ userId: profile.id, code });
      session?.save((err) => {
        if (err) {
          next(err);
          return;
        }
        res.redirect(appendQueryParam(returnTo, "notion_connected", "1"));
      });
    } catch (err) {
      next(err);
    }
  });
}
