export const MCP_SCOPES = ["meetings:read", "transcripts:read"] as const;

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
  clientId: string;
  userId: string;
  scope: string;
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

export type McpAccessTokenInfo = {
  clientId: string;
  userId: string;
  scopes: McpScope[];
  resource: string;
  expiresAt: number;
};
