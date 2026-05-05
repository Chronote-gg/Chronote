import { jest } from "@jest/globals";
import { handleMcpJsonRpcRequest } from "../mcp";
import { listMcpServersForUser } from "../../services/mcpMeetingService";
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

const auth: McpAccessTokenInfo = {
  clientId: "client-1",
  userId: "user-1",
  scopes: ["meetings:read"],
  resource: "http://localhost:3001/mcp",
  expiresAt: 4_102_444_800,
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
});
