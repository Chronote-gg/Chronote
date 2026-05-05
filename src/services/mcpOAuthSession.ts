import type { Request } from "express";
import type { Session } from "express-session";

export type McpConsentSessionRequest = {
  nonce: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  resource: string;
  codeChallenge: string;
};

type McpOAuthSession = Session & {
  mcpAuthorizeRedirect?: string;
  mcpConsentRequest?: McpConsentSessionRequest;
};

const getSession = (req: Request) => req.session as McpOAuthSession | undefined;

export const stashMcpAuthorizeRedirect = (req: Request, redirect: string) => {
  const session = getSession(req);
  if (!session) return false;
  session.mcpAuthorizeRedirect = redirect;
  return true;
};

export const readMcpAuthorizeRedirect = (req: Request) => {
  const session = getSession(req);
  if (!session?.mcpAuthorizeRedirect) return undefined;
  const redirect = session.mcpAuthorizeRedirect;
  session.mcpAuthorizeRedirect = undefined;
  return redirect;
};

export const stashMcpConsentRequest = (
  req: Request,
  consentRequest: McpConsentSessionRequest,
) => {
  const session = getSession(req);
  if (!session) return false;
  session.mcpConsentRequest = consentRequest;
  return true;
};

export const readMcpConsentRequest = (req: Request, nonce: string) => {
  const session = getSession(req);
  const consentRequest = session?.mcpConsentRequest;
  if (!consentRequest || consentRequest.nonce !== nonce) return undefined;
  session.mcpConsentRequest = undefined;
  return consentRequest;
};
