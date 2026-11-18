import { ScanCommand, type ScanCommandInput } from "@aws-sdk/client-dynamodb";
import {
  ChannelType,
  PermissionFlagsBits,
  type APIEmbed,
  type Client,
} from "discord.js";
import { dynamoDbClient, tableName } from "../repositories/dynamoClient";
import { getChronoteDemo } from "./chronoteDemo";
import { config } from "./configService";
import { isShuttingDown } from "./shutdownSignal";
import { isEligible } from "./workerRegistry";

const ABOUT_TITLE = "About Chronote";
const ABOUT_URL = "https://chronote.gg/";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const formatCount = new Intl.NumberFormat("en-US");

export function startChronoteAboutRefresh(client: Client): void {
  if (
    config.mock.enabled ||
    config.database.useLocalDynamoDB ||
    tableName("MeetingHistoryTable") !==
      "meeting-notes-prod-MeetingHistoryTable"
  )
    return;

  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshChronoteAbout(client);
    } catch (error) {
      console.warn("Chronote About refresh failed", error);
    } finally {
      refreshing = false;
    }
  };

  void refresh();
  setInterval(() => void refresh(), REFRESH_MS).unref();
}

export async function refreshChronoteAbout(client: Client): Promise<void> {
  if (!client.isReady() || !isEligible() || isShuttingDown()) return;
  const demo = await getChronoteDemo();
  if (!demo?.aboutChannelId) return;
  const channel = await client.channels.fetch(demo.aboutChannelId);
  if (
    channel?.type !== ChannelType.GuildText ||
    channel.guildId !== demo.guildId
  )
    return;

  if (
    !channel
      .permissionsFor(client.user)
      ?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    throw new Error("Chronote needs Read Message History in #chronote-about");
  }

  let message;
  let before: string | undefined;
  do {
    const messages = await channel.messages.fetch({
      limit: 100,
      before,
      cache: false,
    });
    message = messages.find(
      (candidate) =>
        candidate.author.id === client.user.id &&
        candidate.embeds.some(
          (embed) => embed.title === ABOUT_TITLE && embed.url === ABOUT_URL,
        ),
    );
    before = messages.size === 100 ? messages.last()?.id : undefined;
  } while (!message && before);

  const signal = AbortSignal.timeout(30_000);
  let completed = 0;
  let seconds = 0;
  let cursor: ScanCommandInput["ExclusiveStartKey"];
  do {
    const page = await dynamoDbClient.send(
      new ScanCommand({
        TableName: tableName("MeetingHistoryTable"),
        FilterExpression: "#status = :complete",
        ExpressionAttributeNames: {
          "#status": "status",
          "#duration": "duration",
        },
        ExpressionAttributeValues: { ":complete": { S: "complete" } },
        ProjectionExpression: "#duration",
        ExclusiveStartKey: cursor,
        Limit: 100,
      }),
      { abortSignal: signal },
    );
    completed += page.Count ?? 0;
    for (const item of page.Items ?? []) {
      const duration = Number(item.duration?.N);
      if (Number.isFinite(duration) && duration > 0) seconds += duration;
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  const embed: APIEmbed = {
    title: ABOUT_TITLE,
    url: ABOUT_URL,
    description: [
      `### ${formatCount.format(client.guilds.cache.size)} servers · ${formatCount.format(completed)} meetings · ${formatCount.format(Math.floor(seconds / 3600))} hours`,
      "Chronote records Discord voice meetings and generates transcripts and notes. Search meetings you have access to or ask questions with links back to the source.",
      "**Get started**\n[Add Chronote](https://chronote.gg/join) · [Open portal](https://chronote.gg/portal) · [Docs](https://docs.chronote.gg/)",
      `**Try the demo**\nJoin <#${demo.voiceChannelId}>, run \`/startmeeting\` if recording hasn’t started, and talk about a made-up topic. End the recording to get your notes in <#${demo.outputChannelId}>.`,
      demo.supportChannelId &&
        `**Need help?**\nAsk in <#${demo.supportChannelId}>.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    color: 0x6f75ff,
    thumbnail: { url: "https://chronote.gg/logo192.png" },
  };

  if (!isEligible() || isShuttingDown()) return;
  if (message) {
    if (message.embeds.length !== 1 || !message.embeds[0].equals(embed))
      await message.edit({ embeds: [embed] });
    return;
  }

  // Discord deduplicates concurrent creates during a worker handoff.
  await channel.send({
    embeds: [embed],
    nonce: "chronote-about",
    enforceNonce: true,
  });
}
