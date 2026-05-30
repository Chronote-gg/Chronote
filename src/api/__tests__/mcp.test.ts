import { jest } from "@jest/globals";
import type { Express, RequestHandler } from "express";
import { handleMcpJsonRpcRequest, registerMcpRoutes } from "../mcp";
import {
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
  listMcpMyMeetings,
  listMcpServersForUser,
} from "../../services/mcpMeetingService";
import {
  getMcpLiveMeetingStatus,
  getMcpLiveMeetingTranscript,
  getMcpMeetingControlRequest,
  startMcpMeetingControl,
  stopMcpMeetingControl,
} from "../../services/mcpMeetingControlService";
import {
  markMcpAccessTokenScopeChallenge,
  validateMcpAccessToken,
} from "../../services/mcpOAuthService";
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

jest.mock("../../services/mcpMeetingControlService", () => ({
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

const captureMcpGetHandler = () => {
  let getHandler: RequestHandler | undefined;
  const app = {
    get: jest.fn((_path: string, handler: RequestHandler) => {
      getHandler = handler;
    }),
    post: jest.fn(),
  };
  registerMcpRoutes(app as unknown as Express);
  if (!getHandler) throw new Error("MCP GET route was not registered.");
  return getHandler;
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
          expect.objectContaining({ name: "start_meeting" }),
          expect.objectContaining({ name: "stop_meeting" }),
          expect.objectContaining({ name: "get_live_meeting_status" }),
        ]),
      },
    });
  });

  it("rejects start meeting without meetings:start", async () => {
    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "start-scope",
        method: "tools/call",
        params: {
          name: "start_meeting",
          arguments: {},
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "start-scope",
      error: { code: -32001, message: "Insufficient OAuth scope." },
    });
  });

  it("calls start_meeting with queued command result", async () => {
    jest.mocked(startMcpMeetingControl).mockResolvedValue({
      requestId: "request-1",
      queueStatus: "completed",
      commandType: "start_meeting",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      result: {
        status: "started",
        serverId: "guild-1",
        meetingId: "meeting-1",
        voiceChannelId: "voice-1",
        textChannelId: "text-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "meetings:start"] },
        {
          jsonrpc: "2.0",
          id: "start-call",
          method: "tools/call",
          params: {
            name: "start_meeting",
            arguments: {
              serverId: "guild-1",
              textChannelId: "text-1",
              tags: ["planning"],
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "start-call",
      result: {
        structuredContent: {
          requestId: "request-1",
          requestStatus: "completed",
          status: "started",
          meetingId: "meeting-1",
        },
        isError: false,
      },
    });

    expect(startMcpMeetingControl).toHaveBeenCalledWith({
      userId: "user-1",
      request: {
        serverId: "guild-1",
        textChannelId: "text-1",
        tags: ["planning"],
      },
    });
  });

  it("returns queued pending meeting control requests", async () => {
    jest.mocked(stopMcpMeetingControl).mockResolvedValue({
      requestId: "request-2",
      queueStatus: "pending",
      commandType: "stop_meeting",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "meetings:stop"] },
        {
          jsonrpc: "2.0",
          id: "stop-call",
          method: "tools/call",
          params: {
            name: "stop_meeting",
            arguments: { serverId: "guild-1" },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "stop-call",
      result: {
        structuredContent: {
          requestId: "request-2",
          requestStatus: "pending",
          commandType: "stop_meeting",
        },
        isError: false,
      },
    });
  });

  it("returns failed meeting control requests as tool errors", async () => {
    jest.mocked(getMcpMeetingControlRequest).mockResolvedValue({
      requestId: "request-3",
      queueStatus: "failed",
      commandType: "start_meeting",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      error: "Join a Discord voice channel first, then retry.",
    });

    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:start"] },
        {
          jsonrpc: "2.0",
          id: "request-status",
          method: "tools/call",
          params: {
            name: "get_meeting_control_request",
            arguments: { requestId: "request-3" },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "request-status",
      result: {
        content: [
          {
            type: "text",
            text: "Join a Discord voice channel first, then retry.",
          },
        ],
        isError: true,
      },
    });
  });

  it("calls live meeting status with authenticated user id", async () => {
    jest.mocked(getMcpLiveMeetingStatus).mockResolvedValue({
      requestId: "request-4",
      queueStatus: "completed",
      commandType: "get_live_meeting_status",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      result: {
        status: "in_progress",
        serverId: "guild-1",
        meetingId: "meeting-1",
        voiceChannelId: "voice-1",
      },
    });

    await expect(
      handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "live-status",
        method: "tools/call",
        params: {
          name: "get_live_meeting_status",
          arguments: { serverId: "guild-1", meetingId: "meeting-1" },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "live-status",
      result: {
        structuredContent: {
          requestId: "request-4",
          requestStatus: "completed",
          status: "in_progress",
        },
        isError: false,
      },
    });

    expect(getMcpLiveMeetingStatus).toHaveBeenCalledWith({
      userId: "user-1",
      request: { serverId: "guild-1", meetingId: "meeting-1" },
    });
  });

  it("calls live meeting transcript with transcript scope", async () => {
    jest.mocked(getMcpLiveMeetingTranscript).mockResolvedValue({
      requestId: "request-5",
      queueStatus: "completed",
      commandType: "get_live_meeting_transcript",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      result: {
        serverId: "guild-1",
        meetingId: "meeting-1",
        events: [{ id: "event-1", type: "voice", time: "0:01", text: "Hi" }],
        hasMore: false,
      },
    });

    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "transcripts:read"] },
        {
          jsonrpc: "2.0",
          id: "live-transcript",
          method: "tools/call",
          params: {
            name: "get_live_meeting_transcript",
            arguments: { serverId: "guild-1", afterEventId: "event-0" },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "live-transcript",
      result: {
        structuredContent: {
          requestId: "request-5",
          requestStatus: "completed",
          events: [{ id: "event-1", text: "Hi" }],
        },
        isError: false,
      },
    });

    expect(getMcpLiveMeetingTranscript).toHaveBeenCalledWith({
      userId: "user-1",
      request: { serverId: "guild-1", afterEventId: "event-0" },
    });
  });

  it("requires serverId for live meeting transcript routing", async () => {
    await expect(
      handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "transcripts:read"] },
        {
          jsonrpc: "2.0",
          id: "live-transcript-missing-server",
          method: "tools/call",
          params: {
            name: "get_live_meeting_transcript",
            arguments: { afterEventId: "event-0" },
          },
        },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "live-transcript-missing-server",
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("serverId"),
          },
        ],
        isError: true,
      },
    });

    expect(getMcpLiveMeetingTranscript).not.toHaveBeenCalled();
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
          ownershipScope: "guild",
          ownerUserId: undefined,
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
          portalUrl: "https://chronote.gg/portal/meetings/guild-1/meeting-key",
          serverId: "guild-1",
          serverName: "Server 1",
          serverIcon: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
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
            cursor: "cursor-page-2",
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
        cursor: "cursor-page-2",
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
      hasMore: false,
      nextCursor: null,
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
        ownershipScope: "guild",
        ownerUserId: undefined,
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

  it("returns a step-up OAuth challenge for single-tool insufficient scope", async () => {
    jest.mocked(validateMcpAccessToken).mockResolvedValue(auth);
    const postHandler = captureMcpPostHandler();
    const response = createResponse();

    await postHandler(
      {
        headers: { authorization: "Bearer token" },
        body: {
          jsonrpc: "2.0",
          id: "start-scope",
          method: "tools/call",
          params: { name: "start_meeting", arguments: {} },
        },
      } as never,
      response as never,
      jest.fn(),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "insufficient_scope" });
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="insufficient_scope" scope="meetings:read meetings:start"',
    );
    expect(markMcpAccessTokenScopeChallenge).toHaveBeenCalledWith("token", [
      "meetings:read",
      "meetings:start",
    ]);
  });

  it("returns OAuth discovery challenge before origin rejection", async () => {
    const getHandler = captureMcpGetHandler();
    const response = createResponse();

    await getHandler(
      { headers: { origin: "https://mcp-client.example" } } as never,
      response as never,
      jest.fn(),
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });
});
