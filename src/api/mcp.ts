import type { Express, Request, Response } from "express";
import { z } from "zod";
import { config } from "../services/configService";
import {
  buildMcpBearerChallenge,
  formatMcpScope,
  hasMcpScopes,
  validateMcpAccessToken,
} from "../services/mcpOAuthService";
import {
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
  listMcpMeetings,
  listMcpServersForUser,
  McpMeetingAccessError,
} from "../services/mcpMeetingService";
import type { McpAccessTokenInfo, McpScope } from "../types/mcpOAuth";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const JSON_RPC_VERSION = "2.0";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type McpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const listServersSchema = z.object({}).passthrough().optional();
const listMeetingsSchema = z.object({
  serverId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  channelId: z.string().min(1).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  tags: z.array(z.string().min(1)).optional(),
  includeArchived: z.boolean().optional(),
});
const meetingLookupSchema = z.object({
  serverId: z.string().min(1),
  meetingId: z.string().min(1),
});

const toolDefinitions: McpToolDefinition[] = [
  {
    name: "list_servers",
    title: "List Chronote Servers",
    description:
      "List Discord servers where the authenticated user can access Chronote meeting data.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "list_meetings",
    title: "List Chronote Meetings",
    description:
      "List recent Chronote meetings in a server, filtered to meetings the user can access.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "Discord server ID." },
        limit: { type: "number", minimum: 1, maximum: 100 },
        channelId: {
          type: "string",
          description: "Optional voice channel ID filter.",
        },
        startDate: { type: "string", format: "date-time" },
        endDate: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string" } },
        includeArchived: { type: "boolean" },
      },
      required: ["serverId"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_meeting_summary",
    title: "Get Chronote Meeting Summary",
    description:
      "Fetch notes and summary metadata for one accessible Chronote meeting.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "Discord server ID." },
        meetingId: {
          type: "string",
          description: "Chronote meeting id from list_meetings.",
        },
      },
      required: ["serverId", "meetingId"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_meeting_transcript",
    title: "Get Chronote Meeting Transcript",
    description:
      "Fetch transcript text for one accessible Chronote meeting. Requires transcripts:read.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "Discord server ID." },
        meetingId: {
          type: "string",
          description: "Chronote meeting id from list_meetings.",
        },
      },
      required: ["serverId", "meetingId"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
];

const toolScopes = new Map<string, McpScope[]>([
  ["list_servers", ["meetings:read"]],
  ["list_meetings", ["meetings:read"]],
  ["get_meeting_summary", ["meetings:read"]],
  ["get_meeting_transcript", ["meetings:read", "transcripts:read"]],
]);

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { jsonrpc?: unknown; method?: unknown };
  return (
    candidate.jsonrpc === JSON_RPC_VERSION &&
    typeof candidate.method === "string"
  );
};

const getBearerToken = (req: Request) => {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length).trim();
};

const sendUnauthorized = (res: Response) => {
  res.set("WWW-Authenticate", buildMcpBearerChallenge());
  res.status(401).json({ error: "unauthorized" });
};

const sendInsufficientScope = (res: Response, scopes: McpScope[]) => {
  res.set("WWW-Authenticate", buildMcpBearerChallenge(formatMcpScope(scopes)));
  res.status(403).json({ error: "insufficient_scope" });
};

const jsonRpcResult = (id: JsonRpcId | undefined, result: unknown) => ({
  jsonrpc: JSON_RPC_VERSION,
  id: id ?? null,
  result,
});

const jsonRpcError = (
  id: JsonRpcId | undefined,
  code: number,
  message: string,
) => ({
  jsonrpc: JSON_RPC_VERSION,
  id: id ?? null,
  error: { code, message },
});

const toolResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  isError: false,
});

const toolError = (message: string) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const mapMeetingError = (error: unknown) => {
  if (!(error instanceof McpMeetingAccessError)) return undefined;
  if (error.code === "not_found") return toolError("Meeting not found.");
  if (error.code === "forbidden") return toolError("Meeting access required.");
  if (error.code === "rate_limited")
    return toolError("Discord rate limited. Please retry.");
  return toolError(error.message);
};

async function callTool(auth: McpAccessTokenInfo, name: string, args: unknown) {
  try {
    if (name === "list_servers") {
      listServersSchema.parse(args);
      return toolResult({ servers: await listMcpServersForUser(auth.userId) });
    }
    if (name === "list_meetings") {
      const input = listMeetingsSchema.parse(args);
      return toolResult(
        await listMcpMeetings({
          userId: auth.userId,
          guildId: input.serverId,
          limit: input.limit,
          channelId: input.channelId,
          startDate: input.startDate,
          endDate: input.endDate,
          tags: input.tags,
          includeArchived: input.includeArchived,
        }),
      );
    }
    if (name === "get_meeting_summary") {
      const input = meetingLookupSchema.parse(args);
      return toolResult(
        await getMcpMeetingSummary({
          userId: auth.userId,
          guildId: input.serverId,
          meetingId: input.meetingId,
        }),
      );
    }
    if (name === "get_meeting_transcript") {
      const input = meetingLookupSchema.parse(args);
      return toolResult(
        await getMcpMeetingTranscript({
          userId: auth.userId,
          guildId: input.serverId,
          meetingId: input.meetingId,
        }),
      );
    }
    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof z.ZodError) return toolError("Invalid tool input.");
    return mapMeetingError(error) ?? toolError("Unexpected tool error.");
  }
}

export async function handleMcpJsonRpcRequest(
  auth: McpAccessTokenInfo,
  request: JsonRpcRequest,
) {
  if (request.id === undefined) return undefined;
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "chronote",
          title: "Chronote",
          version: config.server.npmPackageVersion,
        },
      });
    }
    if (request.method === "ping") return jsonRpcResult(request.id, {});
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: toolDefinitions });
    }
    if (request.method === "tools/call") {
      const params = z
        .object({ name: z.string(), arguments: z.unknown().optional() })
        .parse(request.params);
      const requiredScopes = toolScopes.get(params.name) ?? [];
      if (!hasMcpScopes(auth.scopes, requiredScopes)) {
        return jsonRpcError(request.id, -32001, "Insufficient OAuth scope.");
      }
      return jsonRpcResult(
        request.id,
        await callTool(auth, params.name, params.arguments ?? {}),
      );
    }
    return jsonRpcError(
      request.id,
      -32601,
      `Method not found: ${request.method}`,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonRpcError(request.id, -32602, "Invalid params.");
    }
    console.error("Unexpected MCP request error", error);
    return jsonRpcError(request.id, -32603, "Internal error.");
  }
}

export function registerMcpRoutes(app: Express) {
  app.get(config.mcp.endpointPath, (req, res) => {
    if (!getBearerToken(req)) {
      sendUnauthorized(res);
      return;
    }
    res.set("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
  });

  app.post(config.mcp.endpointPath, async (req, res) => {
    const rawToken = getBearerToken(req);
    if (!rawToken) {
      sendUnauthorized(res);
      return;
    }
    const auth = await validateMcpAccessToken(rawToken);
    if (!auth) {
      sendUnauthorized(res);
      return;
    }
    const requestBodies = Array.isArray(req.body) ? req.body : [req.body];
    if (!requestBodies.every(isJsonRpcRequest)) {
      res
        .status(400)
        .json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."));
      return;
    }
    const callRequest = requestBodies.find(
      (body) =>
        body.method === "tools/call" &&
        typeof (body.params as { name?: unknown } | undefined)?.name ===
          "string",
    );
    const requestedToolName = (
      callRequest?.params as { name?: string } | undefined
    )?.name;
    const requiredScopes = requestedToolName
      ? toolScopes.get(requestedToolName)
      : undefined;
    if (requiredScopes && !hasMcpScopes(auth.scopes, requiredScopes)) {
      sendInsufficientScope(res, requiredScopes);
      return;
    }
    const responses = await Promise.all(
      requestBodies.map((request) => handleMcpJsonRpcRequest(auth, request)),
    );
    const responseBodies = responses.filter(
      (response) => response !== undefined,
    );
    if (responseBodies.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(Array.isArray(req.body) ? responseBodies : responseBodies[0]);
  });
}
