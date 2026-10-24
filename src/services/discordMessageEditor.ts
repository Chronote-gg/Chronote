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
type DiscordMessageTarget = {
  channelId: string;
  messageId: string;
  signal?: AbortSignal;
};

export class DiscordMessageHttpError extends Error {
  constructor(
    operation: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
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
  const retryTiming = async (
    response: Response,
  ): Promise<number | undefined> => {
    const candidates = [
      response.headers.get("Retry-After"),
      response.headers.get("X-RateLimit-Reset-After"),
    ].flatMap((value) => (value === null ? [] : [Number(value)]));
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "retry_after" in body &&
        typeof body.retry_after === "number"
      )
        candidates.push(body.retry_after);
    } catch {
      /* Headers still provide definite retry timing. */
    }
    const valid = candidates.filter(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER,
    );
    return valid.length ? Math.max(...valid) : undefined;
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
      throw new DiscordMessageHttpError(
        operation,
        response.status,
        response.status === 429 ? await retryTiming(response) : undefined,
      );
    }
    return response;
  };
  const getJson = async (
    path: string,
    operation: string,
    allowMissing = false,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const response = await request(path, operation, { signal }, allowMissing);
    return response ? response.json() : null;
  };

  return {
    getBotIdentity: (signal?: AbortSignal) =>
      getJson("/users/@me", "bot identity fetch", false, signal),
    getChannel: (channelId: string, signal?: AbortSignal) =>
      getJson(`/channels/${channelId}`, "channel fetch", false, signal),
    getMessage: ({ channelId, messageId, signal }: DiscordMessageTarget) =>
      getJson(
        `/channels/${channelId}/messages/${messageId}`,
        "message fetch",
        true,
        signal,
      ),
    updateMessage: async ({
      channelId,
      messageId,
      payload,
      signal,
    }: DiscordMessageTarget & { payload: Record<string, unknown> }) =>
      (await request(
        `/channels/${channelId}/messages/${messageId}`,
        "message update",
        { method: "PATCH", body: JSON.stringify(payload), signal },
        true,
      )) !== null,
    writeNotesMessage: async ({
      channelId,
      messageId,
      embeds,
      signal,
    }: {
      channelId: string;
      messageId?: string;
      embeds: Record<string, unknown>[];
      signal?: AbortSignal;
    }): Promise<unknown> => {
      const response = await request(
        `/channels/${channelId}/messages${messageId ? "/" + messageId : ""}`,
        "notes write",
        {
          method: messageId ? "PATCH" : "POST",
          body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } }),
          signal,
        },
      );
      return response!.json();
    },
    deleteNotesMessage: async ({
      channelId,
      messageId,
      signal,
    }: DiscordMessageTarget): Promise<void> => {
      const response = await request(
        `/channels/${channelId}/messages/${messageId}`,
        "notes deletion",
        { method: "DELETE", signal },
      );
      if (response?.status !== 204)
        throw new Error("Discord deletion outcome is unverified");
    },
  };
}

export function createDiscordMessageEditor(options: DiscordTransportOptions) {
  const transport = createDiscordMessageTransport(options);
  return {
    getBotIdentity: async (signal?: AbortSignal): Promise<DiscordBotIdentity> =>
      discordBotIdentitySchema.parse(await transport.getBotIdentity(signal)),
    getChannel: async (
      channelId: string,
      signal?: AbortSignal,
    ): Promise<DiscordChannel> =>
      discordChannelSchema.parse(await transport.getChannel(channelId, signal)),
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
      signal,
    }: DiscordMessageTarget & {
      embeds: Array<Record<string, unknown>>;
    }): Promise<"acknowledged" | "missing"> =>
      (await transport.updateMessage({
        channelId,
        messageId,
        payload: { embeds, allowed_mentions: { parse: [] } },
        signal,
      }))
        ? "acknowledged"
        : "missing",
  };
}
