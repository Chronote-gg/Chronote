export const DESKTOP_AUTH_SCOPES = [
  "profile:read",
  "personal_uploads:write",
  "meetings:read",
] as const;

export type DesktopAuthScope = (typeof DESKTOP_AUTH_SCOPES)[number];

export type DesktopAuthorizationCode = {
  codeHash: string;
  userId: string;
  username: string;
  avatar?: string | null;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  createdAt: string;
  expiresAt: number;
};

export type DesktopAuthToken = {
  tokenHash: string;
  tokenType: "access" | "refresh";
  pairedTokenHash?: string;
  userId: string;
  username: string;
  avatar?: string | null;
  scope: string;
  createdAt: string;
  expiresAt: number;
};

export type DesktopAccessTokenInfo = {
  userId: string;
  username: string;
  avatar?: string | null;
  scopes: DesktopAuthScope[];
  expiresAt: number;
};
