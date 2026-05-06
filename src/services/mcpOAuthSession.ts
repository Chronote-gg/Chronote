import type { Request } from "express";
import type { Session } from "express-session";

type McpOAuthSession = Session & {
  mcpAuthorizeRedirect?: string;
  mcpConsentNonce?: string;
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

export const stashMcpConsentNonce = (req: Request, nonce: string) => {
  const session = getSession(req);
  if (!session) return false;
  session.mcpConsentNonce = nonce;
  return true;
};

export const consumeMcpConsentNonce = (req: Request) => {
  const session = getSession(req);
  if (!session?.mcpConsentNonce) return undefined;
  const nonce = session.mcpConsentNonce;
  session.mcpConsentNonce = undefined;
  return nonce;
};
