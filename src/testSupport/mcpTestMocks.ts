import { jest } from "@jest/globals";
import type { McpAccessTokenInfo } from "../types/mcpOAuth";

jest.mock("../services/meetingSearchService", () => ({
  searchMeetingsForUser: jest.fn(),
  searchTranscriptsForUser: jest.fn(),
}));

jest.mock("../services/mcpMeetingService", () => ({
  DEFAULT_MCP_TRANSCRIPT_MAX_CHARS: 20_000,
  MAX_MCP_TRANSCRIPT_MAX_CHARS: 100_000,
  McpMeetingAccessError: class McpMeetingAccessError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  getMcpMeetingSummary: jest.fn(),
  getMcpMeetingTranscript: jest.fn(),
  listMcpMyMeetings: jest.fn(),
  listMcpMeetings: jest.fn(),
  listMcpServersForToken: jest.fn(),
}));

jest.mock("../services/mcpOAuthService", () => ({
  buildMcpBearerChallenge: jest.fn(
    (options?: string | { error?: string; scope?: string }) => {
      if (!options) return "Bearer";
      const scope = typeof options === "string" ? options : options.scope;
      const error = typeof options === "string" ? undefined : options.error;
      return [
        "Bearer",
        error ? `error="${error}"` : undefined,
        scope ? `scope="${scope}"` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    },
  ),
  formatMcpScope: jest.fn((scopes: string[]) => scopes.join(" ")),
  hasMcpScopes: jest.fn((granted: string[], required: string[]) =>
    required.every((scope) => granted.includes(scope)),
  ),
  markMcpAccessTokenScopeChallenge: jest.fn(),
  validateMcpAccessToken: jest.fn(),
}));

jest.mock("../services/mcpServiceAccountService", () => ({
  isMcpServiceAccountToken: jest.fn((token: string) =>
    token.startsWith("cnsa_"),
  ),
  validateMcpServiceAccountToken: jest.fn(),
}));

jest.mock("../services/mcpMeetingControlService", () => ({
  McpMeetingControlError: class McpMeetingControlError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  getMcpLiveMeetingStatus: jest.fn(),
  getMcpLiveMeetingTranscript: jest.fn(),
  getMcpMeetingControlRequest: jest.fn(),
  startMcpMeetingControl: jest.fn(),
  stopMcpMeetingControl: jest.fn(),
}));

export const mcpReadAuth: McpAccessTokenInfo = {
  clientId: "client-1",
  userId: "user-1",
  scopes: ["meetings:read"],
  resource: "http://localhost:3001/mcp",
  expiresAt: 4_102_444_800,
};
