import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Profile } from "passport-discord";
import {
  createPersonalRecordingSegmentUploadIntent,
  createPersonalRecordingUploadSession,
  getPersonalMediaUploadJobForUser,
  markPersonalRecordingSegmentUploadComplete,
  PersonalMediaUploadError,
  submitPersonalRecordingUpload,
} from "../services/personalMediaUploadService";
import {
  DESKTOP_AUTH_SCOPES,
  type DesktopAuthScope,
} from "../types/desktopAuth";
import {
  DesktopAuthError,
  exchangeDesktopAuthorizationCode,
  getDesktopAuthSecret,
  hasDesktopScopes,
  issueDesktopAuthorizationCode,
  isDesktopRedirectUriAllowed,
  parseDesktopScopes,
  refreshDesktopAccessToken,
  revokeDesktopToken,
  validateDesktopAccessToken,
} from "../services/desktopAuthService";
import { createAuthRateLimiter } from "../services/authRateLimitService";
import {
  PERSONAL_RECORDING_MAX_SOURCES,
  PERSONAL_RECORDING_SEGMENT_MAX_BYTES,
} from "../constants";
import { readConsentToken, signConsentToken } from "../utils/consentToken";
import { htmlEscape } from "../utils/html";

const DESKTOP_RATE_LIMIT_WINDOW_MS = 60_000;
const DESKTOP_RATE_LIMIT_MAX = 60;
const DESKTOP_CONSENT_PATH = "/api/desktop/auth/authorize/consent";
const DESKTOP_CONSENT_TTL_MS = 5 * 60 * 1000;
const DESKTOP_SCOPE_DESCRIPTIONS: Record<DesktopAuthScope, string> = {
  "profile:read": "See your Chronote account name and avatar",
  "personal_uploads:write": "Upload recordings to your personal meetings",
  "meetings:read": "Read your meetings, including transcripts and notes",
};
const REQUIRED_UPLOAD_SCOPES: DesktopAuthScope[] = ["personal_uploads:write"];
const REQUIRED_PROFILE_SCOPES: DesktopAuthScope[] = ["profile:read"];

const hasUniqueSourceIds = (sources: Array<{ sourceId: string }>) =>
  new Set(sources.map((source) => source.sourceId)).size === sources.length;

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

const recordingSourceSchema = z.object({
  sourceId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  kind: z.enum(["owner_mic", "system_output"]),
  label: z.string().min(1).max(80).optional(),
});

const recordingSessionSchema = z.object({
  sources: z
    .array(recordingSourceSchema)
    .min(1)
    .max(PERSONAL_RECORDING_MAX_SOURCES)
    .refine(hasUniqueSourceIds, {
      message: "sourceId values must be unique.",
    }),
});

const recordingSegmentIntentSchema = z.object({
  uploadId: z.string().uuid(),
  sourceId: recordingSourceSchema.shape.sourceId,
  sequence: z.number().int().min(0),
  contentType: z.string().min(1),
  fileSize: z.number().int().min(1).max(PERSONAL_RECORDING_SEGMENT_MAX_BYTES),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMillis: z.number().int().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  originalFileName: z.string().min(1).max(255).optional(),
});

const recordingSegmentCompleteSchema = z.object({
  uploadId: z.string().uuid(),
  sourceId: recordingSourceSchema.shape.sourceId,
  sequence: z.number().int().min(0),
  key: z.string().min(1).max(1024),
  uploadToken: z.string().min(1).max(512),
});

const recordingSubmitSchema = z.object({
  uploadId: z.string().uuid(),
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

const buildAuthorizeUrl = (req: Request) => {
  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart >= 0 ? req.originalUrl.slice(queryStart) : "";
  return `${req.baseUrl}${req.path}${query}`;
};

const stashAuthorizeRedirect = (req: Request, redirect: string) => {
  const session = req.session as typeof req.session & {
    oauthRedirect?: string;
  };
  session.oauthRedirect = redirect;
};

type DesktopConsentSession = Request["session"] & {
  desktopConsentNonces?: string[];
};

// Two desktop instances can legitimately have a consent page open at once, each
// with its own loopback listener, so a single nonce slot would make whichever
// page was opened first fail on approval. Bounded so a program that opens
// authorize repeatedly cannot grow the session record without limit; the oldest
// pending consent is dropped instead.
const MAX_PENDING_CONSENTS = 5;

const stashConsentNonce = (req: Request, nonce: string) => {
  const session = req.session as DesktopConsentSession | undefined;
  if (!session) return false;
  const pending = session.desktopConsentNonces ?? [];
  session.desktopConsentNonces = [...pending, nonce].slice(
    -MAX_PENDING_CONSENTS,
  );
  return true;
};

// Single use: an approval must not be replayable, and the desktop flow has no
// client identity, so this nonce is the only thing tying a submitted consent
// form back to the browser session that was shown it.
const consumeConsentNonce = (req: Request, nonce: string) => {
  const session = req.session as DesktopConsentSession | undefined;
  const pending = session?.desktopConsentNonces;
  if (!session || !pending?.includes(nonce)) return false;
  session.desktopConsentNonces = pending.filter(
    (candidate) => candidate !== nonce,
  );
  return true;
};

type DesktopConsentRequest = {
  nonce: string;
  userId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
};

const isDesktopConsentRequest = (
  value: unknown,
): value is DesktopConsentRequest => {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DesktopConsentRequest>;
  return (
    typeof request.nonce === "string" &&
    typeof request.userId === "string" &&
    typeof request.redirectUri === "string" &&
    typeof request.codeChallenge === "string" &&
    typeof request.codeChallengeMethod === "string" &&
    typeof request.expiresAt === "number" &&
    (request.scope === undefined || typeof request.scope === "string") &&
    (request.state === undefined || typeof request.state === "string")
  );
};

// The session cookie is SameSite=None in production, so this authenticated page
// would otherwise render inside a frame on any origin. The local program this
// consent step exists to constrain is well placed to open such a page, hide it
// behind its own UI, and clickjack the approval. Nothing else in the app sets
// these headers, so they are set here rather than assumed.
const sendConsentPage = (res: Response, html: string) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.type("html").send(html);
};

const renderDesktopConsentPage = (params: {
  scopes: DesktopAuthScope[];
  redirectUri: string;
  consentToken: string;
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect Chronote Desktop</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 560px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; }
      h1 { margin-top: 0; font-size: 1.4rem; }
      ul { padding-left: 20px; }
      li { margin-bottom: 6px; }
      code { word-break: break-all; color: #bfdbfe; }
      .note { color: #94a3b8; font-size: 0.9rem; }
      .actions { display: flex; gap: 12px; margin-top: 24px; }
      button { border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
      .approve { background: #93c5fd; color: #0f172a; }
      .deny { background: #334155; color: #e2e8f0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect Chronote Desktop</h1>
      <p>An application on this computer is asking to connect to your Chronote account and would be able to:</p>
      <ul>
        ${params.scopes
          .map(
            (scope) =>
              `<li>${htmlEscape(DESKTOP_SCOPE_DESCRIPTIONS[scope])}</li>`,
          )
          .join("\n        ")}
      </ul>
      <p class="note">It will send you back to <code>${htmlEscape(params.redirectUri)}</code>. Chronote cannot verify which application started this, so only continue if you just opened Chronote Desktop yourself.</p>
      <form method="post" action="${DESKTOP_CONSENT_PATH}">
        <input type="hidden" name="consent_token" value="${htmlEscape(params.consentToken)}" />
        <div class="actions">
          <button class="approve" type="submit" name="decision" value="approve">Connect</button>
          <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
        </div>
      </form>
    </main>
  </body>
</html>`;

const getBearerToken = (req: Request) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
};

// Split from the scope check on purpose. Identifying the caller is what lets
// the rate limiters tell an unknown token apart from a known one, so it has to
// happen before any later rejection: a scope failure raised while the request
// still looked anonymous would be charged to the caller's IP and spend an
// allowance shared with everybody at that address.
const requireDesktopToken = async (
  req: DesktopRequest,
  res: Response,
  next: () => void,
) => {
  const token = getBearerToken(req);
  const auth = token ? await validateDesktopAccessToken(token) : undefined;
  if (!auth) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  req.desktopAuth = auth;
  next();
};

const requireDesktopScopes =
  (requiredScopes: DesktopAuthScope[] = []) =>
  (req: DesktopRequest, res: Response, next: () => void) => {
    const auth = req.desktopAuth;
    if (!auth || !hasDesktopScopes(auth.scopes, requiredScopes)) {
      res.status(403).json({ error: "insufficient_scope" });
      return;
    }
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
  // Protected routes take two limiters, and the order matters.
  //
  // The first is keyed by IP but counts only rejected requests. A caller with
  // no valid token cannot escape it by rotating bearer values, which a token
  // key alone would allow: every made-up token would mint its own bucket while
  // still costing a token lookup. Authenticated traffic passes through it
  // uncounted, so clients sharing an office or VPN address do not collide.
  //
  // The second runs after the token is validated and is keyed by that token,
  // which is the limit that actually applies in normal use. The client polls
  // upload status every two seconds, so a shared IP bucket would have two users
  // 429ing each other on polling alone.
  const rejectedRateLimiter = createAuthRateLimiter({
    enabled: true,
    windowMs: DESKTOP_RATE_LIMIT_WINDOW_MS,
    limit: DESKTOP_RATE_LIMIT_MAX,
    countFailuresOnly: true,
    // requireDesktopToken sets desktopAuth as soon as a token checks out, so
    // anything rejected after that point (wrong scope, bad payload) belongs to
    // an identified caller and is left to their own token bucket.
    wasAuthenticated: (req) => Boolean((req as DesktopRequest).desktopAuth),
  });
  const tokenRateLimiter = createAuthRateLimiter({
    enabled: true,
    windowMs: DESKTOP_RATE_LIMIT_WINDOW_MS,
    limit: DESKTOP_RATE_LIMIT_MAX,
    perBearerToken: true,
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
      const scopes = parseDesktopScopes(input.scope);
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

      // A signed-in session is not consent. This flow has no client identity,
      // so any local process can start it, and only the person at the browser
      // can say whether they meant to.
      const user = req.user as Pick<Profile, "id" | "username" | "avatar">;
      const nonce = crypto.randomBytes(16).toString("base64url");
      if (!stashConsentNonce(req, nonce)) {
        throw new DesktopAuthError(
          "server_error",
          "Unable to start desktop consent.",
          500,
        );
      }
      const consentToken = signConsentToken<DesktopConsentRequest>(
        {
          nonce,
          userId: user.id,
          redirectUri: input.redirect_uri,
          scope: input.scope,
          state: input.state,
          codeChallenge: input.code_challenge,
          codeChallengeMethod: input.code_challenge_method,
          expiresAt: Date.now() + DESKTOP_CONSENT_TTL_MS,
        },
        getDesktopAuthSecret(),
      );
      req.session.save((error) => {
        if (error) {
          sendOAuthError(res, error);
          return;
        }
        sendConsentPage(
          res,
          renderDesktopConsentPage({
            scopes,
            redirectUri: input.redirect_uri,
            consentToken,
          }),
        );
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

  app.post(DESKTOP_CONSENT_PATH, rateLimiter, async (req, res) => {
    const token =
      typeof req.body?.consent_token === "string"
        ? req.body.consent_token
        : undefined;
    const consent = token
      ? readConsentToken(token, getDesktopAuthSecret(), isDesktopConsentRequest)
      : undefined;
    const nonceMatched = consent
      ? consumeConsentNonce(req, consent.nonce)
      : false;
    const user = req.user as Pick<Profile, "id" | "username" | "avatar">;
    if (
      !req.isAuthenticated?.() ||
      !user ||
      !consent ||
      !nonceMatched ||
      user.id !== consent.userId
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    if (req.body?.decision !== "approve") {
      redirectWithError(res, {
        redirectUri: consent.redirectUri,
        error: "access_denied",
        description: "Desktop authorization was cancelled.",
        state: consent.state,
      });
      return;
    }

    try {
      const code = await issueDesktopAuthorizationCode({
        user,
        redirectUri: consent.redirectUri,
        scope: consent.scope,
        codeChallenge: consent.codeChallenge,
        codeChallengeMethod: consent.codeChallengeMethod,
      });
      redirectWithCode(res, {
        redirectUri: consent.redirectUri,
        code,
        state: consent.state,
      });
    } catch (error) {
      const desktopError =
        error instanceof DesktopAuthError ? error : undefined;
      redirectWithError(res, {
        redirectUri: consent.redirectUri,
        error: desktopError?.code ?? "server_error",
        description: desktopError?.message,
        state: consent.state,
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
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_PROFILE_SCOPES),
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
    "/api/desktop/recordings/session",
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingSessionSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json(
          await createPersonalRecordingUploadSession({
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
    "/api/desktop/recordings/segment-intent",
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingSegmentIntentSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json(
          await createPersonalRecordingSegmentUploadIntent({
            userId: user.userId,
            ...input,
          }),
        );
      } catch (error) {
        sendUploadError(res, error);
      }
    },
  );

  app.post(
    "/api/desktop/recordings/segment-complete",
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingSegmentCompleteSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json({
          segment: await markPersonalRecordingSegmentUploadComplete({
            userId: user.userId,
            ...input,
          }),
        });
      } catch (error) {
        sendUploadError(res, error);
      }
    },
  );

  app.post(
    "/api/desktop/recordings/submit",
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_UPLOAD_SCOPES),
    async (req: DesktopRequest, res) => {
      try {
        const input = recordingSubmitSchema.parse(req.body);
        const user = getDesktopUser(req);
        res.json({
          job: await submitPersonalRecordingUpload({
            userId: user.userId,
            uploadId: input.uploadId,
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
    rejectedRateLimiter,
    requireDesktopToken,
    tokenRateLimiter,
    requireDesktopScopes(REQUIRED_UPLOAD_SCOPES),
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
