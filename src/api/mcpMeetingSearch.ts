import { z } from "zod";
import type { McpAccessTokenInfo } from "../types/mcpOAuth";
import type {
  MeetingRef,
  MeetingSearchPrincipal,
} from "../types/meetingSearch";
import type { McpToolDefinition } from "./mcp";
import {
  searchMeetingsForUser,
  searchTranscriptsForUser,
} from "../services/meetingSearchService";
import { listMcpServersForToken } from "../services/mcpMeetingService";
import { assertTokenGuildId, resolveTokenServerIds } from "./mcpTokenScope";

const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const meetingRefSchema = z
  .object({ serverId: z.string().min(1), id: z.string().min(1) })
  .strict();
const searchPageFields = {
  pageSize: z.number().int().min(1).max(25).optional(),
  cursor: z.string().min(1).optional(),
};
const searchMeetingsSchema = z
  .object({
    query: z.string().trim().min(1),
    filters: z
      .object({
        serverIds: z.array(z.string().min(1)).min(1).optional(),
        meetingIds: z.array(meetingRefSchema).min(1).optional(),
        from: z.string().datetime().optional(),
        before: z.string().datetime().optional(),
        channelId: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).optional(),
        archive: z.enum(["active", "all", "archived"]).optional(),
      })
      .strict()
      .optional(),
    ...searchPageFields,
  })
  .strict();
const searchTranscriptsSchema = z
  .object({
    query: z.string().trim().min(1),
    meetingIds: z.array(meetingRefSchema).min(1),
    ...searchPageFields,
  })
  .strict();
const meetingRefJsonSchema = {
  type: "object",
  properties: {
    serverId: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
  },
  required: ["serverId", "id"],
  additionalProperties: false,
};
const searchPageJsonFields = {
  pageSize: { type: "integer", minimum: 1, maximum: 25 },
  cursor: { type: "string" },
};

export const mcpMeetingSearchDefinitions: McpToolDefinition[] = [
  {
    name: "search_meetings",
    title: "Search Chronote Meetings",
    description:
      "Search accessible retained meetings by title, summary and complete current notes. Scope is bound to the authenticated user and token. Read these complete records before investigating selected transcripts. Results report partial coverage when applicable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        ...searchPageJsonFields,
        filters: {
          type: "object",
          properties: {
            serverIds: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            meetingIds: {
              type: "array",
              minItems: 1,
              items: meetingRefJsonSchema,
            },
            from: { type: "string", format: "date-time" },
            before: { type: "string", format: "date-time" },
            channelId: {
              type: "string",
              description:
                "Voice or associated text channel filter, within token restrictions.",
            },
            tags: { type: "array", items: { type: "string" } },
            archive: { type: "string", enum: ["active", "all", "archived"] },
          },
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: "search_transcripts",
    title: "Search Selected Chronote Transcripts",
    description:
      "Search transcript passages within a required nonempty selected meeting set. Discover meetings and inspect their complete current notes first. Requires meetings:read and transcripts:read. No global transcript search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        meetingIds: { type: "array", minItems: 1, items: meetingRefJsonSchema },
        ...searchPageJsonFields,
      },
      required: ["query", "meetingIds"],
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
];

function assertMeetingRefs(
  auth: McpAccessTokenInfo,
  meetings: MeetingRef[] = [],
) {
  for (const meeting of meetings)
    assertTokenGuildId(auth.restriction, meeting.serverId);
}
async function searchPrincipal(
  auth: McpAccessTokenInfo,
): Promise<MeetingSearchPrincipal> {
  const servers = await listMcpServersForToken({
    userId: auth.userId,
    restriction: auth.restriction,
  });
  return {
    userId: auth.userId,
    serverIds: servers.map((server) => server.id),
    ...(auth.restriction
      ? { restriction: auth.restriction }
      : { scope: { kind: "all" } }),
  };
}
export async function callMcpMeetingSearchTool(
  auth: McpAccessTokenInfo,
  name: string,
  args: unknown,
) {
  if (name === "search_meetings") {
    const input = searchMeetingsSchema.parse(args);
    resolveTokenServerIds(auth.restriction, input.filters?.serverIds);
    assertMeetingRefs(auth, input.filters?.meetingIds);
    return searchMeetingsForUser(await searchPrincipal(auth), input);
  }
  if (name === "search_transcripts") {
    const input = searchTranscriptsSchema.parse(args);
    assertMeetingRefs(auth, input.meetingIds);
    return searchTranscriptsForUser(await searchPrincipal(auth), input);
  }
  return undefined;
}
