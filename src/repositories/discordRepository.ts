import { ExponentialBackoff, handleWhen, retry } from "cockatiel";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
} from "./types";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export class DiscordApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const shouldRetryDiscordError = (error: Error) => {
  if (isDiscordApiError(error)) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
};

const discordRetryPolicy = retry(handleWhen(shouldRetryDiscordError), {
  maxAttempts: 3,
  backoff: new ExponentialBackoff(),
});

const withDiscordRetry = async <T>(operation: () => Promise<T>) =>
  discordRetryPolicy.execute(operation);

export const assertDiscordSnowflake = (value: string, label: string) => {
  if (!DISCORD_SNOWFLAKE_PATTERN.test(value)) {
    throw new DiscordApiError(400, `Invalid Discord ${label}`);
  }
  return value;
};

export type DiscordRepository = {
  listUserGuilds: (accessToken: string) => Promise<DiscordGuild[]>;
  listBotGuilds: () => Promise<DiscordGuild[]>;
  listGuildChannels: (guildId: string) => Promise<DiscordChannel[]>;
  listGuildRoles: (guildId: string) => Promise<DiscordRole[]>;
  getGuildMember: (
    guildId: string,
    userId: string,
  ) => Promise<DiscordGuildMember>;
};

const realRepository: DiscordRepository = {
  async listUserGuilds(accessToken: string) {
    return withDiscordRetry(async () => {
      const resp = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) {
        throw new DiscordApiError(resp.status, "Unable to fetch user guilds");
      }
      return (await resp.json()) as DiscordGuild[];
    });
  },
  async listBotGuilds() {
    return withDiscordRetry(async () => {
      const resp = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bot ${config.discord.botToken}` },
      });
      if (!resp.ok) {
        throw new DiscordApiError(resp.status, "Unable to fetch bot guilds");
      }
      return (await resp.json()) as DiscordGuild[];
    });
  },
  async listGuildChannels(guildId: string) {
    const validGuildId = assertDiscordSnowflake(guildId, "guild id");
    return withDiscordRetry(async () => {
      const resp = await fetch(
        `https://discord.com/api/guilds/${validGuildId}/channels`,
        {
          headers: { Authorization: `Bot ${config.discord.botToken}` },
        },
      );
      if (!resp.ok) {
        throw new DiscordApiError(
          resp.status,
          "Unable to fetch guild channels",
        );
      }
      return (await resp.json()) as DiscordChannel[];
    });
  },
  async listGuildRoles(guildId: string) {
    const validGuildId = assertDiscordSnowflake(guildId, "guild id");
    return withDiscordRetry(async () => {
      const resp = await fetch(
        `https://discord.com/api/guilds/${validGuildId}/roles`,
        {
          headers: { Authorization: `Bot ${config.discord.botToken}` },
        },
      );
      if (!resp.ok) {
        throw new DiscordApiError(resp.status, "Unable to fetch guild roles");
      }
      return (await resp.json()) as DiscordRole[];
    });
  },
  async getGuildMember(guildId: string, userId: string) {
    const validGuildId = assertDiscordSnowflake(guildId, "guild id");
    const validUserId = assertDiscordSnowflake(userId, "user id");
    return withDiscordRetry(async () => {
      const resp = await fetch(
        `https://discord.com/api/guilds/${validGuildId}/members/${validUserId}`,
        {
          headers: { Authorization: `Bot ${config.discord.botToken}` },
        },
      );
      if (!resp.ok) {
        throw new DiscordApiError(resp.status, "Unable to fetch guild member");
      }
      return (await resp.json()) as DiscordGuildMember;
    });
  },
};

const mockRepository: DiscordRepository = {
  async listUserGuilds() {
    return getMockStore().userGuilds;
  },
  async listBotGuilds() {
    return getMockStore().botGuilds;
  },
  async listGuildChannels(guildId: string) {
    return getMockStore().channelsByGuild.get(guildId) ?? [];
  },
  async listGuildRoles(guildId: string) {
    return getMockStore().rolesByGuild.get(guildId) ?? [];
  },
  async getGuildMember(guildId: string, userId: string) {
    const member =
      getMockStore().membersByGuild.get(`${guildId}#${userId}`) ?? null;
    if (!member) {
      throw new DiscordApiError(404, "Unable to fetch guild member");
    }
    return member;
  },
};

export function getDiscordRepository(): DiscordRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}

export function isDiscordApiError(error: unknown): error is DiscordApiError {
  return error instanceof DiscordApiError;
}
