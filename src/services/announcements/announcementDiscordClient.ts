import { z } from "zod";
import type { DiscordChannel } from "../../repositories/types";
import { DiscordMessageHttpError } from "../discordMessageEditor";
import { permissionOverwritesSchema } from "../discordRestSchemas";
import { type AnnouncementEmbed, isSnowflake } from "./announcementTypes";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
/** Used when a 429 carries no usable retry timing. */
const DEFAULT_RETRY_AFTER_MS = 1_000;
const GUILD_PAGE_SIZE = 200;
const HTTP_TOO_MANY_REQUESTS = 429;

export type AnnouncementDiscordClient = {
  getBotUserId(): Promise<string>;
  listBotGuildIds(): Promise<string[]>;
  getGuild(guildId: string): Promise<{
    id: string;
    name: string;
    ownerId: string;
    roles: { id: string; permissions?: string | null }[];
    publicUpdatesChannelId: string | null;
    systemChannelId: string | null;
  }>;
  listGuildChannels(guildId: string): Promise<DiscordChannel[]>;
  getMemberRoleIds(guildId: string, userId: string): Promise<string[]>;
  openDmChannel(userId: string): Promise<string>;
  createMessage(
    channelId: string,
    embed: AnnouncementEmbed,
    options?: { content?: string },
  ): Promise<{ id: string }>;
};

const idObjectSchema = z.object({ id: z.string() }).passthrough();
const guildSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string(),
  roles: z.array(
    z.object({
      id: z.string(),
      permissions: z.string().nullable().optional(),
    }),
  ),
  public_updates_channel_id: z.string().nullable().optional(),
  system_channel_id: z.string().nullable().optional(),
});
const channelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.number(),
    position: z.number().optional(),
    permission_overwrites: permissionOverwritesSchema.optional(),
  })
  .passthrough();
const memberSchema = z.object({ roles: z.array(z.string()) });
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    retry_after: z.number().optional(),
  })
  .passthrough();

const snowflake = (value: string, label: string): string => {
  if (!isSnowflake(value))
    throw new Error(`${label} is not a Discord snowflake id`);
  return value;
};

const retryDelayMs = (
  header: string | null,
  body: z.infer<typeof errorBodySchema> | null,
): number => {
  const seconds = header === null ? body?.retry_after : Number(header);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
};

const readErrorBody = async (response: Response) => {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** REST-only Discord access for the operator announcement command. */
export function createAnnouncementDiscordClient({
  token,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): AnnouncementDiscordClient {
  const request = async (
    operation: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      // A fetch rejection (timeout, abort, network) propagates unchanged: the
      // caller cannot tell whether a write landed, so it is never retried here.
      const response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        // No caller signal: an interrupt must not abort a post that may land.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      const body = await readErrorBody(response);
      const delayMs =
        response.status === HTTP_TOO_MANY_REQUESTS
          ? retryDelayMs(response.headers.get("Retry-After"), body)
          : undefined;
      if (delayMs === undefined || attempt >= RATE_LIMIT_ATTEMPTS)
        throw new DiscordMessageHttpError(
          operation,
          response.status,
          delayMs === undefined ? undefined : delayMs / 1000,
          body?.code,
        );
      await sleep(delayMs);
    }
  };

  return {
    getBotUserId: async () =>
      idObjectSchema.parse(await request("bot identity fetch", "/users/@me"))
        .id,
    listBotGuildIds: async () => {
      const ids: string[] = [];
      for (;;) {
        const after = ids.at(-1);
        const page = z
          .array(idObjectSchema)
          .parse(
            await request(
              "bot guild list",
              `/users/@me/guilds?limit=${GUILD_PAGE_SIZE}${after ? `&after=${after}` : ""}`,
            ),
          );
        ids.push(...page.map((guild) => guild.id));
        if (page.length < GUILD_PAGE_SIZE) return ids;
      }
    },
    getGuild: async (guildId) => {
      const guild = guildSchema.parse(
        await request(
          "guild fetch",
          `/guilds/${snowflake(guildId, "guildId")}`,
        ),
      );
      return {
        id: guild.id,
        name: guild.name,
        ownerId: guild.owner_id,
        roles: guild.roles,
        publicUpdatesChannelId: guild.public_updates_channel_id ?? null,
        systemChannelId: guild.system_channel_id ?? null,
      };
    },
    listGuildChannels: async (guildId) =>
      z
        .array(channelSchema)
        .parse(
          await request(
            "guild channel list",
            `/guilds/${snowflake(guildId, "guildId")}/channels`,
          ),
        ),
    getMemberRoleIds: async (guildId, userId) =>
      memberSchema.parse(
        await request(
          "guild member fetch",
          `/guilds/${snowflake(guildId, "guildId")}/members/${snowflake(userId, "userId")}`,
        ),
      ).roles,
    openDmChannel: async (userId) =>
      idObjectSchema.parse(
        await request("DM channel open", "/users/@me/channels", {
          method: "POST",
          body: { recipient_id: snowflake(userId, "userId") },
        }),
      ).id,
    createMessage: async (channelId, embed, options = {}) => ({
      id: idObjectSchema.parse(
        await request(
          "announcement create",
          `/channels/${snowflake(channelId, "channelId")}/messages`,
          {
            method: "POST",
            body: {
              embeds: [embed],
              allowed_mentions: { parse: [] },
              ...(options.content === undefined
                ? {}
                : { content: options.content }),
            },
          },
        ),
      ).id,
    }),
  };
}
