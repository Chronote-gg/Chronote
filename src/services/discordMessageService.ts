import { config } from "./configService";
import { createDiscordMessageTransport } from "./discordMessageEditor";

type DiscordMessage = {
  id: string;
  embeds?: Array<Record<string, unknown>>;
};

type DiscordMessagePayload = {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
  allowed_mentions?: { parse: string[] };
};

const buildHeaders = () => ({
  Authorization: `Bot ${config.discord.botToken}`,
  "Content-Type": "application/json",
});

export async function fetchDiscordMessage(
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> {
  const transport = createDiscordMessageTransport({
    token: config.discord.botToken,
  });
  return (await transport.getMessage({
    channelId,
    messageId,
  })) as DiscordMessage | null;
}

export async function updateDiscordMessage(
  channelId: string,
  messageId: string,
  payload: Partial<DiscordMessagePayload>,
): Promise<boolean> {
  const transport = createDiscordMessageTransport({
    token: config.discord.botToken,
  });
  return transport.updateMessage({ channelId, messageId, payload });
}

export async function updateDiscordMessageEmbeds(
  channelId: string,
  messageId: string,
  embeds: Array<Record<string, unknown>>,
): Promise<boolean> {
  return updateDiscordMessage(channelId, messageId, { embeds });
}

export async function createDiscordMessage(
  channelId: string,
  payload: DiscordMessagePayload,
  signal?: AbortSignal,
): Promise<DiscordMessage> {
  const resp = await fetch(
    `https://discord.com/api/channels/${channelId}/messages`,
    {
      method: "POST",
      signal,
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    },
  );
  if (!resp.ok) {
    throw new Error(`Discord message create failed (${resp.status})`);
  }
  return (await resp.json()) as DiscordMessage;
}

export async function deleteDiscordMessage(
  channelId: string,
  messageId: string,
): Promise<boolean> {
  const resp = await fetch(
    `https://discord.com/api/channels/${channelId}/messages/${messageId}`,
    {
      method: "DELETE",
      headers: buildHeaders(),
    },
  );
  if (resp.status === 404) return false;
  if (!resp.ok) {
    throw new Error(`Discord message delete failed (${resp.status})`);
  }
  return true;
}
