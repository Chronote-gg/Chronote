export const MCP_SCOPES = [
  "meetings:read",
  "transcripts:read",
  "meetings:start",
  "meetings:stop",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export type McpOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  clientUri?: string;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: "none";
  createdAt: string;
  updatedAt: string;
};

export type McpOAuthAuthorizationCode = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  createdAt: string;
  expiresAt: number;
};

export type McpOAuthToken = {
  tokenHash: string;
  tokenType: "access" | "refresh";
  pairedTokenHash?: string;
  clientId: string;
  userId: string;
  scope: string;
  scopeChallenge?: string;
  scopeChallengeExpiresAt?: number;
  resource: string;
  createdAt: string;
  expiresAt: number;
};

export type McpOAuthConsent = {
  userId: string;
  clientId: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Hard bounds carried by a service account bearer token. Enforced on every MCP
 * tool call in addition to the Discord permission checks every caller gets, so
 * a restricted token can only ever see less than the bound identity could.
 */
export type McpTokenRestriction = {
  guildId: string;
  channelIds?: string[];
};

export type McpAccessTokenInfo = {
  clientId: string;
  userId: string;
  scopes: McpScope[];
  resource: string;
  expiresAt: number;
  restriction?: McpTokenRestriction;
};
