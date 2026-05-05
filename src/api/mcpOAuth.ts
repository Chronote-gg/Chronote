import crypto from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import type { Profile } from "passport-discord";
import { config } from "../services/configService";
import {
  exchangeMcpAuthorizationCode,
  formatMcpScope,
  getMcpIssuer,
  getMcpOAuthClient,
  getMcpOAuthSecret,
  getMcpResourceUrl,
  grantMcpOAuthConsent,
  hasMcpOAuthConsent,
  issueMcpAuthorizationCode,
  McpOAuthError,
  parseMcpScopes,
  refreshMcpAccessToken,
  registerMcpOAuthClient,
  revokeMcpToken,
} from "../services/mcpOAuthService";
import { stashMcpAuthorizeRedirect } from "../services/mcpOAuthSession";
import { createAuthRateLimiter } from "../services/authRateLimitService";
import { MCP_SCOPES } from "../types/mcpOAuth";

const JSON_CONTENT_TYPE = "application/json";
const MCP_OAUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const MCP_OAUTH_RATE_LIMIT_MAX = 20;

type McpConsentRequest = {
  nonce: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  resource: string;
  codeChallenge: string;
  userId: string;
  expiresAt: number;
};

const sendOAuthError = (res: Response, error: unknown) => {
  if (error instanceof McpOAuthError) {
    res
      .status(error.status)
      .json({ error: error.code, error_description: error.message });
    return;
  }
  console.error("Unexpected MCP OAuth error", error);
  res
    .status(500)
    .json({ error: "server_error", error_description: "Unexpected error." });
};

const getString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const redirectWithOAuthError = (
  res: Response,
  params: {
    redirectUri: string;
    error: string;
    description?: string;
    state?: string;
  },
) => {
  const url = new URL(params.redirectUri);
  url.searchParams.set("error", params.error);
  if (params.description)
    url.searchParams.set("error_description", params.description);
  if (params.state) url.searchParams.set("state", params.state);
  res.redirect(url.toString());
};

const redirectWithAuthorizationCode = (
  res: Response,
  params: {
    redirectUri: string;
    code: string;
    state?: string;
  },
) => {
  const url = new URL(params.redirectUri);
  url.searchParams.set("code", params.code);
  if (params.state) url.searchParams.set("state", params.state);
  res.redirect(url.toString());
};

const htmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const createConsentSignature = (payload: string) =>
  crypto
    .createHmac("sha256", getMcpOAuthSecret())
    .update(payload)
    .digest("base64url");

const encodeConsentRequest = (request: McpConsentRequest) => {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64url",
  );
  return `${payload}.${createConsentSignature(payload)}`;
};

const signaturesMatch = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const isConsentRequest = (value: unknown): value is McpConsentRequest => {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<McpConsentRequest>;
  return (
    typeof request.nonce === "string" &&
    typeof request.clientId === "string" &&
    typeof request.redirectUri === "string" &&
    typeof request.scope === "string" &&
    typeof request.resource === "string" &&
    typeof request.codeChallenge === "string" &&
    typeof request.userId === "string" &&
    typeof request.expiresAt === "number" &&
    (request.state === undefined || typeof request.state === "string")
  );
};

const decodeConsentRequest = (token: string) => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  if (!signaturesMatch(signature, createConsentSignature(payload))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (!isConsentRequest(parsed)) return undefined;
    if (parsed.expiresAt <= Date.now()) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

const renderConsentPage = (params: {
  clientName: string;
  redirectUri: string;
  scope: string;
  consentToken: string;
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize Chronote MCP</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 560px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; }
      h1 { margin-top: 0; }
      code { word-break: break-all; color: #bfdbfe; }
      .actions { display: flex; gap: 12px; margin-top: 24px; }
      button { border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
      .approve { background: #93c5fd; color: #0f172a; }
      .deny { background: #334155; color: #e2e8f0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize Chronote MCP</h1>
      <p><strong>${htmlEscape(params.clientName)}</strong> wants to access Chronote through MCP.</p>
      <p>Requested scopes: <code>${htmlEscape(params.scope)}</code></p>
      <p>Redirect URI: <code>${htmlEscape(params.redirectUri)}</code></p>
      <form method="post" action="/oauth/authorize/consent">
        <input type="hidden" name="consent_token" value="${htmlEscape(params.consentToken)}" />
        <div class="actions">
          <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
          <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>
    </main>
  </body>
</html>`;

const buildAuthorizeUrl = (req: Request) =>
  `${config.mcp.publicBaseUrl}${req.originalUrl}`;

async function finishAuthorize(
  req: Request,
  res: Response,
  options: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state?: string;
    resource: string;
    codeChallenge: string;
    userId?: string;
  },
) {
  const user = req.user as Profile;
  const code = await issueMcpAuthorizationCode({
    clientId: options.clientId,
    userId: options.userId ?? user.id,
    redirectUri: options.redirectUri,
    scope: options.scope,
    resource: options.resource,
    codeChallenge: options.codeChallenge,
    codeChallengeMethod: "S256",
  });
  redirectWithAuthorizationCode(res, {
    redirectUri: options.redirectUri,
    code,
    state: options.state,
  });
}

const createMcpOAuthRateLimiter = () =>
  createAuthRateLimiter({
    enabled: !config.mock.enabled,
    windowMs: MCP_OAUTH_RATE_LIMIT_WINDOW_MS,
    limit: MCP_OAUTH_RATE_LIMIT_MAX,
  });

export function registerMcpOAuthStatelessRoutes(
  app: Express,
  rateLimiter: RequestHandler = createMcpOAuthRateLimiter(),
) {
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.type(JSON_CONTENT_TYPE).json({
      resource: getMcpResourceUrl(),
      authorization_servers: [getMcpIssuer()],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  app.get(
    `/.well-known/oauth-protected-resource${config.mcp.endpointPath}`,
    (_req, res) => {
      res.type(JSON_CONTENT_TYPE).json({
        resource: getMcpResourceUrl(),
        authorization_servers: [getMcpIssuer()],
        scopes_supported: MCP_SCOPES,
        bearer_methods_supported: ["header"],
      });
    },
  );

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const issuer = getMcpIssuer();
    res.type(JSON_CONTENT_TYPE).json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: MCP_SCOPES,
    });
  });

  app.post("/oauth/register", rateLimiter, async (req, res) => {
    try {
      const client = await registerMcpOAuthClient(req.body ?? {});
      res.status(201).json({
        client_id: client.clientId,
        client_name: client.clientName,
        client_uri: client.clientUri,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      });
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/authorize/consent", rateLimiter, async (req, res) => {
    try {
      const token = getString(req.body?.consent_token);
      const consentRequest = token ? decodeConsentRequest(token) : undefined;
      if (!consentRequest) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      if (req.body?.decision !== "approve") {
        redirectWithOAuthError(res, {
          redirectUri: consentRequest.redirectUri,
          error: "access_denied",
          state: consentRequest.state,
        });
        return;
      }
      await grantMcpOAuthConsent({
        userId: consentRequest.userId,
        clientId: consentRequest.clientId,
        scopes: parseMcpScopes(consentRequest.scope),
      });
      await finishAuthorize(req, res, consentRequest);
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/token", rateLimiter, async (req, res) => {
    try {
      const grantType = req.body?.grant_type;
      if (grantType === "authorization_code") {
        res.json(
          await exchangeMcpAuthorizationCode({
            clientId: req.body.client_id,
            code: req.body.code,
            redirectUri: req.body.redirect_uri,
            codeVerifier: req.body.code_verifier,
            resource: req.body.resource,
          }),
        );
        return;
      }
      if (grantType === "refresh_token") {
        res.json(
          await refreshMcpAccessToken({
            clientId: req.body.client_id,
            refreshToken: req.body.refresh_token,
            resource: req.body.resource,
          }),
        );
        return;
      }
      throw new McpOAuthError(
        "unsupported_grant_type",
        "Unsupported grant type.",
      );
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/revoke", rateLimiter, async (req, res) => {
    const token = getString(req.body?.token);
    if (token) await revokeMcpToken(token);
    res.status(200).json({});
  });
}

export function registerMcpOAuthSessionRoutes(
  app: Express,
  rateLimiter: RequestHandler = createMcpOAuthRateLimiter(),
) {
  app.get("/oauth/authorize", rateLimiter, async (req, res) => {
    const redirectUri = getString(req.query.redirect_uri);
    const state = getString(req.query.state);
    let verifiedRedirectUri: string | undefined;
    try {
      const clientId = getString(req.query.client_id);
      const resource = getString(req.query.resource);
      const codeChallenge = getString(req.query.code_challenge);
      const codeChallengeMethod = getString(req.query.code_challenge_method);
      if (!clientId || !redirectUri || !resource || !codeChallenge) {
        throw new McpOAuthError(
          "invalid_request",
          "Missing required authorization parameter.",
        );
      }
      const client = await getMcpOAuthClient(clientId);
      if (!client)
        throw new McpOAuthError("invalid_client", "Unknown MCP client.");
      if (!client.redirectUris.includes(redirectUri)) {
        throw new McpOAuthError(
          "invalid_request",
          "Redirect URI does not match the registered client.",
        );
      }
      verifiedRedirectUri = redirectUri;
      if (req.query.response_type !== "code") {
        throw new McpOAuthError(
          "unsupported_response_type",
          "Only code response type is supported.",
        );
      }
      if (codeChallengeMethod !== "S256") {
        throw new McpOAuthError("invalid_request", "PKCE S256 is required.");
      }
      const scope = formatMcpScope(parseMcpScopes(getString(req.query.scope)));

      if (!req.isAuthenticated?.()) {
        if (!stashMcpAuthorizeRedirect(req, buildAuthorizeUrl(req))) {
          throw new McpOAuthError(
            "server_error",
            "Unable to start authorization.",
            500,
          );
        }
        req.session.save((error) => {
          if (error) {
            sendOAuthError(res, error);
            return;
          }
          res.redirect("/auth/discord");
        });
        return;
      }

      const user = req.user as Profile;
      const scopes = parseMcpScopes(scope);
      if (await hasMcpOAuthConsent({ userId: user.id, clientId, scopes })) {
        await finishAuthorize(req, res, {
          clientId,
          redirectUri,
          scope,
          state,
          resource,
          codeChallenge,
        });
        return;
      }

      const nonce = crypto.randomBytes(16).toString("base64url");
      const consentToken = encodeConsentRequest({
        nonce,
        clientId,
        redirectUri,
        scope,
        state,
        resource,
        codeChallenge,
        userId: user.id,
        expiresAt: Date.now() + config.mcp.authorizationCodeTtlSeconds * 1000,
      });
      req.session.save((error) => {
        if (error) {
          sendOAuthError(res, error);
          return;
        }
        res.type("html").send(
          renderConsentPage({
            clientName: client.clientName,
            redirectUri,
            scope,
            consentToken,
          }),
        );
      });
    } catch (error) {
      if (verifiedRedirectUri) {
        const oauthError = error instanceof McpOAuthError ? error : undefined;
        redirectWithOAuthError(res, {
          redirectUri: verifiedRedirectUri,
          error: oauthError?.code ?? "server_error",
          description: oauthError?.message,
          state,
        });
        return;
      }
      sendOAuthError(res, error);
    }
  });
}

export function registerMcpOAuthRoutes(app: Express) {
  const rateLimiter = createMcpOAuthRateLimiter();
  registerMcpOAuthStatelessRoutes(app, rateLimiter);
  registerMcpOAuthSessionRoutes(app, rateLimiter);
}
