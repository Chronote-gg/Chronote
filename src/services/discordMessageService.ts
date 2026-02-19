import { config } from "./configService";

type DiscordMessage = {
  id: string;
  embeds?: Array<Record<string, unknown>>;
};

type DiscordMessagePayload = {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
};

const buildHeaders = () => ({
  Authorization: `Bot ${config.discord.botToken}`,
  "Content-Type": "application/json",
});

export async function fetchDiscordMessage(
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> {
  const resp = await fetch(
    `https://discord.com/api/channels/${channelId}/messages/${messageId}`,
    { headers: buildHeaders() },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Discord message fetch failed (${resp.status})`);
  }
  return (await resp.json()) as DiscordMessage;
}

export async function updateDiscordMessage(
  channelId: string,
  messageId: string,
  payload: Partial<DiscordMessagePayload>,
): Promise<boolean> {
  const resp = await fetch(
    `https://discord.com/api/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    },
  );
  if (resp.status === 404) return false;
  if (!resp.ok) {
    throw new Error(`Discord message update failed (${resp.status})`);
  }
  return true;
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
): Promise<DiscordMessage> {
  const resp = await fetch(
    `https://discord.com/api/channels/${channelId}/messages`,
    {
      method: "POST",
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
