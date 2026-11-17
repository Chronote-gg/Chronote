import { mcpReadAuth as auth } from "../../testSupport/mcpTestMocks";
import { jest } from "@jest/globals";
import { handleMcpJsonRpcRequest } from "../mcp";
import { listMcpServersForToken } from "../../services/mcpMeetingService";
import {
  searchMeetingsForUser,
  searchTranscriptsForUser,
} from "../../services/meetingSearchService";
import { MeetingSearchError } from "../../types/meetingSearch";

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());
describe("MCP meeting search", () => {
  it("binds search to token identity and forwards service account hard restrictions", async () => {
    const restriction = { guildId: "guild-1", channelIds: ["voice-1"] };
    jest
      .mocked(listMcpServersForToken)
      .mockResolvedValue([{ id: "guild-1", name: "Server", icon: null }]);
    jest.mocked(searchMeetingsForUser).mockResolvedValue({
      hits: [],
      nextCursor: null,
      coverage: {
        status: "ready",
        semanticStatus: "ready",
        ranking: "authorized_partition_order",
      },
    });
    const result = await handleMcpJsonRpcRequest(
      { ...auth, restriction },
      {
        jsonrpc: "2.0",
        id: "search",
        method: "tools/call",
        params: {
          name: "search_meetings",
          arguments: { query: "decisions", filters: { channelId: "text-1" } },
        },
      },
    );
    expect(result).toMatchObject({
      result: { isError: false, structuredContent: { hits: [] } },
    });
    expect(searchMeetingsForUser).toHaveBeenCalledWith(
      { userId: auth.userId, serverIds: ["guild-1"], restriction },
      { query: "decisions", filters: { channelId: "text-1" } },
    );
  });

  it("rejects transcript search without transcript scope or a nonempty selected meeting set", async () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: "transcript-search",
      method: "tools/call",
      params: {
        name: "search_transcripts",
        arguments: { query: "detail", meetingIds: [] },
      },
    };
    expect(await handleMcpJsonRpcRequest(auth, request)).toMatchObject({
      error: { code: -32001 },
    });
    expect(
      await handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "transcripts:read"] },
        request,
      ),
    ).toMatchObject({ result: { isError: true } });
    expect(searchTranscriptsForUser).not.toHaveBeenCalled();
  });

  it("rejects service account search scope widening before retrieval", async () => {
    const restricted = {
      ...auth,
      restriction: { guildId: "guild-1", channelIds: ["voice-1"] },
    };
    const result = await handleMcpJsonRpcRequest(restricted, {
      jsonrpc: "2.0",
      id: "search",
      method: "tools/call",
      params: {
        name: "search_meetings",
        arguments: {
          query: "decisions",
          filters: { serverIds: ["other-guild"] },
        },
      },
    });
    expect(result).toMatchObject({ result: { isError: true } });
    expect(searchMeetingsForUser).not.toHaveBeenCalled();
  });

  it("delegates transcript search for selected canonical refs without Pi run state", async () => {
    jest
      .mocked(listMcpServersForToken)
      .mockResolvedValue([{ id: "guild-1", name: "Server", icon: null }]);
    jest.mocked(searchTranscriptsForUser).mockResolvedValue({
      hits: [],
      nextCursor: null,
      coverage: {
        status: "ready",
        semanticStatus: "ready",
        ranking: "authorized_partition_order",
      },
    });
    const input = {
      query: "detail",
      meetingIds: [
        { serverId: "guild-1", id: "voice#2026-10-01T00:00:00.000Z" },
      ],
    };
    expect(
      await handleMcpJsonRpcRequest(
        { ...auth, scopes: ["meetings:read", "transcripts:read"] },
        {
          jsonrpc: "2.0",
          id: "transcript-search",
          method: "tools/call",
          params: { name: "search_transcripts", arguments: input },
        },
      ),
    ).toMatchObject({ result: { isError: false } });
    expect(searchTranscriptsForUser).toHaveBeenCalledWith(
      { userId: auth.userId, serverIds: ["guild-1"], scope: { kind: "all" } },
      input,
    );
  });

  it("returns the shared safe source error envelope", async () => {
    jest
      .mocked(listMcpServersForToken)
      .mockResolvedValue([{ id: "guild-1", name: "Server", icon: null }]);
    jest
      .mocked(searchMeetingsForUser)
      .mockRejectedValueOnce(
        new MeetingSearchError("source_changed", "Source changed."),
      );
    expect(
      await handleMcpJsonRpcRequest(auth, {
        jsonrpc: "2.0",
        id: "search",
        method: "tools/call",
        params: { name: "search_meetings", arguments: { query: "detail" } },
      }),
    ).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "source_changed", retryable: false },
        },
      },
    });
  });
});
