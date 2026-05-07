import { jest } from "@jest/globals";
import type { Express, RequestHandler } from "express";
import { handleMcpJsonRpcRequest, registerMcpRoutes } from "../mcp";
import { listMcpServersForUser } from "../../services/mcpMeetingService";
import { validateMcpAccessToken } from "../../services/mcpOAuthService";
import type { McpAccessTokenInfo } from "../../types/mcpOAuth";

jest.mock("../../services/mcpMeetingService", () => ({
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
          arguments: { serverId: "guild-1", meetingId: "meeting-1" },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: "Insufficient OAuth scope." },
    });
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
