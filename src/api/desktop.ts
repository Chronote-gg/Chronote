import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Profile } from "passport-discord";
import {
  createPersonalRecordingUploadIntent,
  getPersonalMediaUploadJobForUser,
  markPersonalRecordingUploadComplete,
  PersonalMediaUploadError,
} from "../services/personalMediaUploadService";
import {
  DESKTOP_AUTH_SCOPES,
  type DesktopAuthScope,
} from "../types/desktopAuth";
import {
  DesktopAuthError,
  exchangeDesktopAuthorizationCode,
  hasDesktopScopes,
  issueDesktopAuthorizationCode,
  isDesktopRedirectUriAllowed,
  isDesktopUserAllowed,
  parseDesktopScopes,
  refreshDesktopAccessToken,
  revokeDesktopToken,
  validateDesktopAccessToken,
} from "../services/desktopAuthService";
import { createAuthRateLimiter } from "../services/authRateLimitService";
import { config } from "../services/configService";

const DESKTOP_RATE_LIMIT_WINDOW_MS = 60_000;
const DESKTOP_RATE_LIMIT_MAX = 60;
const REQUIRED_UPLOAD_SCOPES: DesktopAuthScope[] = ["personal_uploads:write"];
const REQUIRED_PROFILE_SCOPES: DesktopAuthScope[] = ["profile:read"];

const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
});

const tokenBodySchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_verifier: z.string().min(1),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
  }),
]);

const revokeBodySchema = z.object({
  token: z.string().min(1),
});

const recordingIntentSchema = z.object({
  sources: z
    .array(
      z.object({
        sourceId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/),
        kind: z.enum(["owner_mic", "system_output"]),
        label: z.string().min(1).max(80).optional(),
        contentType: z.string().min(1),
        fileSize: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(4),
});

const recordingCompleteSchema = z.object({
  uploadId: z.string().uuid(),
  sources: z
    .array(
      z.object({
        sourceId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/),
        key: z.string().min(1).max(1024),
        uploadToken: z.string().min(1).max(512),
        originalFileName: z.string().min(1).max(255).optional(),
      }),
    )
    .min(1)
    .max(4),
  title: z.string().min(1).max(100).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

type DesktopRequest = Request & {
  desktopAuth?: Awaited<ReturnType<typeof validateDesktopAccessToken>>;
};

const sendOAuthError = (res: Response, error: unknown) => {
  if (error instanceof DesktopAuthError) {
    res
      .status(error.status)
      .json({ error: error.code, error_description: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", issues: error.issues });
    return;
  }
  console.error("Unexpected desktop auth error", error);
  res.status(500).json({ error: "server_error" });
};

const sendUploadError = (res: Response, error: unknown) => {
  if (error instanceof PersonalMediaUploadError) {
    const status =
      error.code === "not_found" || error.code === "forbidden"
        ? 404
        : error.code === "storage_unavailable" ||
            error.code === "signing_failed"
          ? 500
          : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", issues: error.issues });
    return;
  }
  console.error("Unexpected desktop recording error", error);
  res.status(500).json({ error: "server_error" });
};

const redirectWithError = (
  res: Response,
  options: {
    redirectUri: string;
    error: string;
    description?: string;
    state?: string;
  },
) => {
  const url = new URL(options.redirectUri);
  url.searchParams.set("error", options.error);
  if (options.description)
    url.searchParams.set("error_description", options.description);
  if (options.state) url.searchParams.set("state", options.state);
  res.redirect(url.toString());
};

const redirectWithCode = (
  res: Response,
  options: {
    redirectUri: string;
    code: string;
    state?: string;
  },
) => {
  const url = new URL(options.redirectUri);
  url.searchParams.set("code", options.code);
  if (options.state) url.searchParams.set("state", options.state);
  res.redirect(url.toString());
};

const buildAuthorizeUrl = (req: Request) =>
  `${req.protocol}://${req.get("host")}${req.originalUrl}`;

const stashAuthorizeRedirect = (req: Request, redirect: string) => {
  const session = req.session as typeof req.session & {
    oauthRedirect?: string;
  };
  session.oauthRedirect = redirect;
};

const getBearerToken = (req: Request) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
};

const requireDesktopAuth =
  (requiredScopes: DesktopAuthScope[] = []) =>
  async (req: DesktopRequest, res: Response, next: () => void) => {
    const token = getBearerToken(req);
    const auth = token ? await validateDesktopAccessToken(token) : undefined;
    if (!auth) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (!hasDesktopScopes(auth.scopes, requiredScopes)) {
      res.status(403).json({ error: "insufficient_scope" });
      return;
    }
    if (!isDesktopUserAllowed(auth.userId)) {
      res.status(403).json({
        error: "access_denied",
        message: "Desktop beta is not enabled for this account.",
      });
      return;
    }
    req.desktopAuth = auth;
    next();
  };

const getDesktopUser = (req: DesktopRequest) => {
  const auth = req.desktopAuth;
  if (!auth)
    throw new DesktopAuthError("invalid_token", "Desktop auth required.", 401);
  return auth;
};

export function registerDesktopRoutes(app: Express) {
  const rateLimiter = createAuthRateLimiter({
    enabled: true,
    windowMs: DESKTOP_RATE_LIMIT_WINDOW_MS,
    limit: DESKTOP_RATE_LIMIT_MAX,
  });

  app.get("/api/desktop/auth/scopes", (_req, res) => {
    res.json({ scopes_supported: DESKTOP_AUTH_SCOPES });
  });

  app.get("/api/desktop/auth/authorize", rateLimiter, async (req, res) => {
    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    if (!isDesktopRedirectUriAllowed(input.redirect_uri)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "Desktop redirect URI must use localhost HTTP.",
      });
      return;
    }

    try {
      parseDesktopScopes(input.scope);
      if (!req.isAuthenticated?.()) {
        stashAuthorizeRedirect(req, buildAuthorizeUrl(req));
        req.session.save((error) => {
          if (error) {
            sendOAuthError(res, error);
            return;
          }
          res.redirect("/auth/discord");
        });
        return;
      }

      const code = await issueDesktopAuthorizationCode({
        user: req.user as Pick<Profile, "id" | "username" | "avatar">,
        redirectUri: input.redirect_uri,
        scope: input.scope,
        codeChallenge: input.code_challenge,
        codeChallengeMethod: input.code_challenge_method,
      });
      redirectWithCode(res, {
        redirectUri: input.redirect_uri,
        code,
        state: input.state,
      });
    } catch (error) {
      const desktopError =
        error instanceof DesktopAuthError ? error : undefined;
      redirectWithError(res, {
        redirectUri: input.redirect_uri,
        error: desktopError?.code ?? "server_error",
        description: desktopError?.message,
        state: input.state,
      });
    }
  });

  app.post("/api/desktop/auth/token", rateLimiter, async (req, res) => {
    try {
      const input = tokenBodySchema.parse(req.body);
      if (input.grant_type === "authorization_code") {
        res.json(
          await exchangeDesktopAuthorizationCode({
            code: input.code,
            redirectUri: input.redirect_uri,
            codeVerifier: input.code_verifier,
          }),
        );
        return;
      }
      res.json(
        await refreshDesktopAccessToken({ refreshToken: input.refresh_token }),
      );
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/api/desktop/auth/revoke", rateLimiter, async (req, res) => {
    try {
      const input = revokeBodySchema.parse(req.body);
      await revokeDesktopToken(input.token);
      res.json({});
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.get(
    "/api/desktop/me",
    rateLimiter,
    requireDesktopAuth(REQUIRED_PROFILE_SCOPES),
    (req: DesktopRequest, res) => {
      const user = getDesktopUser(req);
      res.json({
        id: user.userId,
        username: user.username,
        avatar: user.avatar,
        scopes: user.scopes,
      });
    },
  );

  app.post(
    "/api/desktop/recordings/intent",
    rateLimiter,
    requireDesktopAuth(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingIntentSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json(
          await createPersonalRecordingUploadIntent({
            userId: user.userId,
            sources: input.sources,
          }),
        );
      } catch (error) {
        sendUploadError(res, error);
      }
    },
  );

  app.post(
    "/api/desktop/recordings/complete",
    rateLimiter,
    requireDesktopAuth(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingCompleteSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json({
          job: await markPersonalRecordingUploadComplete({
            uploadId: input.uploadId,
            userId: user.userId,
            sources: input.sources,
            title: input.title,
            tags: input.tags,
          }),
        });
      } catch (error) {
        sendUploadError(res, error);
      }
    },
  );

  app.get(
    "/api/desktop/recordings/:uploadId",
    rateLimiter,
    requireDesktopAuth(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const user = getDesktopUser(req);
        const uploadId = z.string().uuid().parse(req.params.uploadId);
        res.json({
          job: await getPersonalMediaUploadJobForUser({
            uploadId,
            userId: user.userId,
          }),
        });
      } catch (error) {
        sendUploadError(res, error);
      }
    },
  );
}

export function registerDesktopRoutesIfEnabled(app: Express) {
  if (!config.desktop.enabled) return;
  registerDesktopRoutes(app);
}
