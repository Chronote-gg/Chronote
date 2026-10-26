import { z } from "zod";

const discordIdSchema = z.string().regex(/^\d+$/);
const discordObjectSchema = z.record(z.string(), z.unknown());

export const discordBotIdentitySchema = z
  .object({ id: discordIdSchema, bot: z.literal(true) })
  .passthrough();
export const discordChannelSchema = z
  .object({
    id: discordIdSchema,
    guild_id: discordIdSchema,
    type: z.number().int().nonnegative(),
  })
  .passthrough();
export const discordEditorMessageSchema = z
  .object({
    id: discordIdSchema,
    channel_id: discordIdSchema,
    author: z.object({ id: discordIdSchema, bot: z.boolean() }).passthrough(),
    content: z.string(),
    embeds: z.array(discordObjectSchema),
    components: z.array(discordObjectSchema).default([]),
    attachments: z.array(z.object({ id: discordIdSchema }).passthrough()),
    flags: z.number().int().nonnegative().default(0),
    webhook_id: discordIdSchema.optional(),
  })
  .passthrough();

export type DiscordBotIdentity = z.infer<typeof discordBotIdentitySchema>;
export type DiscordChannel = z.infer<typeof discordChannelSchema>;
export type DiscordEditorMessage = z.infer<typeof discordEditorMessageSchema>;

type DiscordTransportOptions = { token: string; fetchImpl?: typeof fetch };
type DiscordMessageTarget = { channelId: string; messageId: string };

export class DiscordMessageHttpError extends Error {
  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`Discord ${operation} failed (${status})`);
    this.name = "DiscordMessageHttpError";
  }
}

// Legacy portal edits retain their general payloads and partial response shapes.
export function createDiscordMessageTransport({
  token,
  fetchImpl = fetch,
}: DiscordTransportOptions) {
  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
  const request = async (
    path: string,
    operation: string,
    init: RequestInit = {},
    allowMissing = false,
  ): Promise<Response | null> => {
    const response = await fetchImpl(`https://discord.com/api${path}`, {
      ...init,
      headers,
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      throw new DiscordMessageHttpError(operation, response.status);
    }
    return response;
  };
  const getJson = async (
    path: string,
    operation: string,
    allowMissing = false,
  ): Promise<unknown> => {
    const response = await request(path, operation, {}, allowMissing);
    return response ? response.json() : null;
  };

  return {
    getBotIdentity: () => getJson("/users/@me", "bot identity fetch"),
    getChannel: (channelId: string) =>
      getJson(`/channels/${channelId}`, "channel fetch"),
    getMessage: ({ channelId, messageId }: DiscordMessageTarget) =>
      getJson(
        `/channels/${channelId}/messages/${messageId}`,
        "message fetch",
        true,
      ),
    updateMessage: async ({
      channelId,
      messageId,
      payload,
    }: DiscordMessageTarget & { payload: Record<string, unknown> }) =>
      (await request(
        `/channels/${channelId}/messages/${messageId}`,
        "message update",
        { method: "PATCH", body: JSON.stringify(payload) },
        true,
      )) !== null,
  };
}

export function createDiscordMessageEditor(options: DiscordTransportOptions) {
  const transport = createDiscordMessageTransport(options);
  return {
    getBotIdentity: async (): Promise<DiscordBotIdentity> =>
      discordBotIdentitySchema.parse(await transport.getBotIdentity()),
    getChannel: async (channelId: string): Promise<DiscordChannel> =>
      discordChannelSchema.parse(await transport.getChannel(channelId)),
    getMessage: async (
      target: DiscordMessageTarget,
    ): Promise<DiscordEditorMessage | null> => {
      const message = await transport.getMessage(target);
      return message === null
        ? null
        : discordEditorMessageSchema.parse(message);
    },
    editEmbeds: async ({
      channelId,
      messageId,
      embeds,
    }: DiscordMessageTarget & {
      embeds: Array<Record<string, unknown>>;
    }): Promise<"acknowledged" | "missing"> =>
      (await transport.updateMessage({
        channelId,
        messageId,
        payload: { embeds, allowed_mentions: { parse: [] } },
      }))
        ? "acknowledged"
        : "missing",
  };
}
