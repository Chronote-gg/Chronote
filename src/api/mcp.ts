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
  DEFAULT_MCP_TRANSCRIPT_MAX_CHARS,
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
  listMcpMyMeetings,
  listMcpMeetings,
  listMcpServersForUser,
  MAX_MCP_TRANSCRIPT_MAX_CHARS,
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
const listMyMeetingsSchema = z.object({
  mode: z.enum(["attended", "accessible"]).optional(),
  range: z.enum(["today", "past_7_days", "custom"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  timeZoneOffsetMinutes: z
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60)
    .optional(),
  serverIds: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  archivedOnly: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});
const meetingSummaryLookupSchema = z.object({
  serverId: z.string().min(1),
  id: z.string().min(1),
});

const meetingTranscriptLookupSchema = z.object({
  serverId: z.string().min(1),
  id: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(MAX_MCP_TRANSCRIPT_MAX_CHARS)
    .optional(),
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
        startDate: {
          type: "string",
          format: "date-time",
          description: "Optional inclusive lower timestamp bound.",
        },
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
    name: "list_my_meetings",
    title: "List My Chronote Meetings",
    description:
      "List the authenticated user's Chronote meetings across servers, defaulting to meetings they attended in the past 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["attended", "accessible"],
          description:
            "attended lists meetings the user participated in; accessible lists meetings the user can access through current permissions.",
        },
        range: {
          type: "string",
          enum: ["today", "past_7_days", "custom"],
        },
        limit: { type: "number", minimum: 1, maximum: 100 },
        startDate: {
          type: "string",
          format: "date-time",
          description: "Required when range is custom.",
        },
        endDate: { type: "string", format: "date-time" },
        timeZoneOffsetMinutes: {
          type: "number",
          minimum: -840,
          maximum: 840,
          description:
            "Offset compatible with JavaScript Date.getTimezoneOffset; used by range=today. Defaults to UTC.",
        },
        serverIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord server IDs to include.",
        },
        tags: { type: "array", items: { type: "string" } },
        archivedOnly: { type: "boolean" },
        includeArchived: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_meeting_summary",
    title: "Get Chronote Meeting Summary",
    description:
      "Fetch notes and summary metadata for one accessible Chronote meeting. Pass the list item `id`, not the UUID `meetingId`.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "Discord server ID." },
        id: {
          type: "string",
          description:
            "Meeting lookup id from list_meetings or list_my_meetings (`id`, format channelId#timestamp).",
        },
      },
      required: ["serverId", "id"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_meeting_transcript",
    title: "Get Chronote Meeting Transcript",
    description:
      "Fetch transcript text for one accessible Chronote meeting. Pass the list item `id`, not the UUID `meetingId`. Requires transcripts:read.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "Discord server ID." },
        id: {
          type: "string",
          description:
            "Meeting lookup id from list_meetings or list_my_meetings (`id`, format channelId#timestamp).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Optional transcript character offset for paged reads.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MCP_TRANSCRIPT_MAX_CHARS,
          description: `Optional maximum transcript characters to return. Defaults to ${DEFAULT_MCP_TRANSCRIPT_MAX_CHARS}.`,
        },
      },
      required: ["serverId", "id"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
];

const toolScopes = new Map<string, McpScope[]>([
  ["list_servers", ["meetings:read"]],
  ["list_meetings", ["meetings:read"]],
  ["list_my_meetings", ["meetings:read"]],
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

const invalidJsonRpcRequest = () =>
  jsonRpcError(null, -32600, "Invalid JSON-RPC request.");

const sendInvalidJsonRpcRequest = (res: Response) => {
  res.status(400).json(invalidJsonRpcRequest());
};

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

const parseJsonRpcRequestBodies = (body: unknown) => {
  const requestBodies = Array.isArray(body) ? body : [body];
  if (Array.isArray(body) && body.length === 0) return undefined;
  if (!requestBodies.every(isJsonRpcRequest)) return undefined;
  return requestBodies;
};

const resolveSingleRequestRequiredScopes = (
  body: unknown,
  requestBodies: JsonRpcRequest[],
) => {
  if (Array.isArray(body)) return undefined;
  const callRequest = requestBodies.find(
    (request) =>
      request.method === "tools/call" &&
      typeof (request.params as { name?: unknown } | undefined)?.name ===
        "string",
  );
  const requestedToolName = (
    callRequest?.params as { name?: string } | undefined
  )?.name;
  return requestedToolName ? toolScopes.get(requestedToolName) : undefined;
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
    if (name === "list_my_meetings") {
      const input = listMyMeetingsSchema.parse(args);
      return toolResult(
        await listMcpMyMeetings({
          userId: auth.userId,
          mode: input.mode,
          range: input.range,
          limit: input.limit,
          startDate: input.startDate,
          endDate: input.endDate,
          timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
          serverIds: input.serverIds,
          tags: input.tags,
          archivedOnly: input.archivedOnly,
          includeArchived: input.includeArchived,
        }),
      );
    }
    if (name === "get_meeting_summary") {
      const input = meetingSummaryLookupSchema.parse(args);
      return toolResult(
        await getMcpMeetingSummary({
          userId: auth.userId,
          guildId: input.serverId,
          id: input.id,
        }),
      );
    }
    if (name === "get_meeting_transcript") {
      const input = meetingTranscriptLookupSchema.parse(args);
      return toolResult(
        await getMcpMeetingTranscript({
          userId: auth.userId,
          guildId: input.serverId,
          id: input.id,
          offset: input.offset,
          maxChars: input.maxChars,
        }),
      );
    }
    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof z.ZodError) return toolError("Invalid tool input.");
    const meetingError = mapMeetingError(error);
    if (meetingError) return meetingError;
    console.error("Unexpected MCP tool error", { toolName: name, error });
    return toolError("Unexpected tool error.");
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
    const parsedRequestBodies = parseJsonRpcRequestBodies(req.body);
    if (!parsedRequestBodies) {
      sendInvalidJsonRpcRequest(res);
      return;
    }
    const requiredScopes = resolveSingleRequestRequiredScopes(
      req.body,
      parsedRequestBodies,
    );
    if (requiredScopes && !hasMcpScopes(auth.scopes, requiredScopes)) {
      sendInsufficientScope(res, requiredScopes);
      return;
    }
    const responses = await Promise.all(
      parsedRequestBodies.map((request) =>
        handleMcpJsonRpcRequest(auth, request),
      ),
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
