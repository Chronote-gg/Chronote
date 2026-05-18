import { jest } from "@jest/globals";
import type { Express, RequestHandler } from "express";
import { handleMcpJsonRpcRequest, registerMcpRoutes } from "../mcp";
import {
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
  listMcpMyMeetings,
  listMcpServersForUser,
} from "../../services/mcpMeetingService";
import { validateMcpAccessToken } from "../../services/mcpOAuthService";
import type { McpAccessTokenInfo } from "../../types/mcpOAuth";

jest.mock("../../services/mcpMeetingService", () => ({
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
  listMcpServersForUser: jest.fn(),
}));

jest.mock("../../services/mcpOAuthService", () => ({
  buildMcpBearerChallenge: jest.fn(() => "Bearer"),
  formatMcpScope: jest.fn((scopes: string[]) => scopes.join(" ")),
  hasMcpScopes: jest.fn((granted: string[], required: string[]) =>
    required.every((scope) => granted.includes(scope)),
  ),
  validateMcpAccessToken: jest.fn(),
}));

const auth: McpAccessTokenInfo = {
  clientId: "client-1",
  userId: "user-1",
  scopes: ["meetings:read"],
  resource: "http://localhost:3001/mcp",
  expiresAt: 4_102_444_800,
};

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string>(),
    set: jest.fn((name: string, value: string) => {
      response.headers.set(name, value);
      return response;
    }),
    status: jest.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: jest.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    end: jest.fn(() => response),
  };
  return response;
};

const captureMcpPostHandler = () => {
  let postHandler: RequestHandler | undefined;
  const app = {
    get: jest.fn(),
    post: jest.fn((_path: string, handler: RequestHandler) => {
      postHandler = handler;
    }),
  };
  registerMcpRoutes(app as unknown as Express);
  if (!postHandler) throw new Error("MCP POST route was not registered.");
  return postHandler;
};

describe("MCP JSON-RPC handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the Chronote MCP tool list", async () => {
    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "list_servers" }),
          expect.objectContaining({ name: "list_my_meetings" }),
          expect.objectContaining({ name: "get_meeting_summary" }),
        ]),
      },
    });
  });

  it("calls the list_servers tool with the authenticated user id", async () => {
    jest
      .mocked(listMcpServersForUser)
      .mockResolvedValue([{ id: "guild-1", name: "Server 1", icon: null }]);

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "list_servers", arguments: {} },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        structuredContent: {
          servers: [{ id: "guild-1", name: "Server 1", icon: null }],
        },
        isError: false,
      },
    });
    expect(listMcpServersForUser).toHaveBeenCalledWith("user-1");
  });

  it("rejects transcript access without transcripts:read", async () => {
    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_meeting_transcript",
          arguments: {
            serverId: "guild-1",
            id: "channel-1#2026-01-01T00:00:00.000Z",
          },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: "Insufficient OAuth scope." },
    });
  });

  it("calls list_my_meetings with the authenticated user id", async () => {
    jest.mocked(listMcpMyMeetings).mockResolvedValue({
      mode: "attended",
      range: {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-08T00:00:00.000Z",
      },
      meetings: [
        {
          id: "meeting-key",
          meetingId: "meeting-1",
          status: "complete",
          channelId: "channel-1",
          channelName: "Meeting Room",
          timestamp: "2026-01-02T00:00:00.000Z",
          duration: 60,
          tags: [],
          meetingName: "Meeting 1",
          summarySentence: "Summary.",
          summaryLabel: "Summary",
          notesAvailable: true,
          transcriptAvailable: false,
          audioAvailable: false,
          archivedAt: undefined,
          portalUrl: "https://chronote.gg/portal/server/guild-1/library",
          serverId: "guild-1",
          serverName: "Server 1",
          serverIcon: null,
        },
      ],
    });

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "call-my-meetings",
        method: "tools/call",
        params: {
          name: "list_my_meetings",
          arguments: {
            range: "past_7_days",
            mode: "attended",
            tags: ["planning"],
            archivedOnly: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "call-my-meetings",
      result: {
        structuredContent: {
          meetings: [{ id: "meeting-key", serverId: "guild-1" }],
        },
        isError: false,
      },
    });
    expect(listMcpMyMeetings).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        range: "past_7_days",
        mode: "attended",
        tags: ["planning"],
        archivedOnly: true,
      }),
    );
  });

  it("rejects preset My Meetings ranges with explicit date bounds", async () => {
    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "bad-my-meetings-range",
        method: "tools/call",
        params: {
          name: "list_my_meetings",
          arguments: {
            range: "past_7_days",
            startDate: "2000-01-01T00:00:00.000Z",
            endDate: "2000-01-02T00:00:00.000Z",
          },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "bad-my-meetings-range",
      result: {
        content: [
          {
            type: "text",
            text: "Invalid tool input: startDate and endDate are only allowed when range is custom.",
          },
        ],
        isError: true,
      },
    });

    expect(listMcpMyMeetings).not.toHaveBeenCalled();
  });

  it("allows explicit My Meetings date bounds without an explicit range", async () => {
    jest.mocked(listMcpMyMeetings).mockResolvedValue({
      mode: "attended",
      range: {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      },
      meetings: [],
    });

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "custom-my-meetings-range",
        method: "tools/call",
        params: {
          name: "list_my_meetings",
          arguments: {
            startDate: "2026-01-01T00:00:00.000Z",
            endDate: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "custom-my-meetings-range",
      result: { isError: false },
    });

    expect(listMcpMyMeetings).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        range: undefined,
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      }),
    );
  });

  it("returns an invalid params error for malformed tool calls", async () => {
    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {},
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "Invalid params." },
    });
  });

  it("logs the tool name for unexpected tool errors", async () => {
    const error = new Error("DynamoDB query failed");
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    jest.mocked(listMcpMyMeetings).mockRejectedValueOnce(error);

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "unexpected-tool-error",
        method: "tools/call",
        params: {
          name: "list_my_meetings",
          arguments: { range: "past_7_days" },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "unexpected-tool-error",
      result: {
        content: [{ type: "text", text: "Unexpected tool error." }],
        isError: true,
      },
    });

    expect(consoleError).toHaveBeenCalledWith("Unexpected MCP tool error", {
      toolName: "list_my_meetings",
      error,
    });
  });

  it("passes the list item id to get_meeting_summary", async () => {
    jest.mocked(getMcpMeetingSummary).mockResolvedValue({
      meeting: {
        id: "channel-1#2026-01-01T00:00:00.000Z",
        meetingId: "meeting-1",
        status: "complete",
        channelId: "channel-1",
        channelName: "channel-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        duration: 60,
        tags: [],
        meetingName: undefined,
        summarySentence: undefined,
        summaryLabel: undefined,
        notesAvailable: true,
        transcriptAvailable: false,
        audioAvailable: false,
        archivedAt: undefined,
        portalUrl: "https://chronote.example/meeting",
        notes: "notes",
        notesVersion: 1,
        attendees: [],
        notesChannelId: undefined,
        notesMessageId: undefined,
      },
    });

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "summary-1",
        method: "tools/call",
        params: {
          name: "get_meeting_summary",
          arguments: {
            serverId: "guild-1",
            id: "channel-1#2026-01-01T00:00:00.000Z",
          },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "summary-1",
      result: { isError: false },
    });

    expect(getMcpMeetingSummary).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      id: "channel-1#2026-01-01T00:00:00.000Z",
    });
  });

  it("passes transcript paging arguments to get_meeting_transcript", async () => {
    jest.mocked(getMcpMeetingTranscript).mockResolvedValue({
      meetingId: "meeting-1",
      id: "channel-1#2026-01-01T00:00:00.000Z",
      transcript: "abcd",
      transcriptAvailable: true,
      offset: 10,
      totalChars: 20,
      truncated: true,
      nextOffset: 14,
    });

    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "transcripts:read"] },
        {
          jsonrpc: "2.0",
          id: "transcript-1",
          method: "tools/call",
          params: {
            name: "get_meeting_transcript",
            arguments: {
              serverId: "guild-1",
              id: "channel-1#2026-01-01T00:00:00.000Z",
              offset: 10,
              maxChars: 4,
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "transcript-1",
      result: { isError: false },
    });

    expect(getMcpMeetingTranscript).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      id: "channel-1#2026-01-01T00:00:00.000Z",
      offset: 10,
      maxChars: 4,
    });
  });

  it("rejects empty JSON-RPC batches", async () => {
    jest.mocked(validateMcpAccessToken).mockResolvedValue(auth);
    const postHandler = captureMcpPostHandler();
    const response = createResponse();

    await postHandler(
      { headers: { authorization: "Bearer token" }, body: [] } as never,
      response as never,
      jest.fn(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC request." },
    });
  });
});
