import {
  ChannelType,
  PermissionFlagsBits,
  Routes,
  type APIEmbed,
  type RESTGetAPIChannelMessagesResult,
  type Client,
  type TextChannel,
} from "discord.js";
import { getChronoteDemo } from "./chronoteDemo";
import { config } from "./configService";
import { isShuttingDown } from "./shutdownSignal";
import { isEligible } from "./workerRegistry";

const ABOUT_TITLE = "About Chronote";
const ABOUT_URL = "https://chronote.gg/";
const FIRST_REFRESH_MS = 60_000;
const ABOUT_LOOKBACK_PAGES = 3;
const ABOUT_PAGE_SIZE = 100;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const formatCount = new Intl.NumberFormat("en-US");

export function startChronoteAboutRefresh(client: Client): void {
  if (config.mock.enabled || config.database.useLocalDynamoDB) return;

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

  setTimeout(() => {
    void refresh();
    setInterval(() => void refresh(), REFRESH_MS).unref();
  }, FIRST_REFRESH_MS).unref();
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

  const message = await findAboutPost(channel, client.user);
  const embed = buildAboutEmbed(demo, client.guilds.cache.size);
  if (!isEligible() || isShuttingDown()) return;
  if (message) {
    if (!matchesAboutEmbed(message.embeds, embed))
      await channel.messages.edit(message.id, { embeds: [embed] });
    return;
  }

  // Discord deduplicates concurrent creates during a worker handoff.
  await channel.send({
    embeds: [embed],
    nonce: "chronote-about",
    enforceNonce: true,
  });
}

async function findAboutPost(
  channel: TextChannel,
  clientUser: NonNullable<Client["user"]>,
) {
  if (
    !channel
      .permissionsFor(clientUser)
      ?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    throw new Error("Chronote needs Read Message History in #chronote-about");
  }

  const signal = AbortSignal.timeout(10_000);
  let before: string | undefined;
  for (let page = 0; page < ABOUT_LOOKBACK_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(ABOUT_PAGE_SIZE) });
    if (before) query.set("before", before);
    const recent = (await channel.client.rest.get(
      Routes.channelMessages(channel.id),
      {
        query,
        signal,
      },
    )) as RESTGetAPIChannelMessagesResult;
    const post = recent.find(
      (candidate) =>
        candidate.author.id === clientUser.id &&
        candidate.embeds.some(
          (embed) => embed.title === ABOUT_TITLE && embed.url === ABOUT_URL,
        ),
    );
    if (post) return post;
    if (recent.length < ABOUT_PAGE_SIZE) return undefined;
    before = recent[recent.length - 1].id;
  }
  throw new Error("Could not verify whether the About post already exists");
}

function matchesAboutEmbed(embeds: readonly APIEmbed[], expected: APIEmbed) {
  const existing = embeds[0];
  return (
    embeds.length === 1 &&
    existing.title === expected.title &&
    existing.url === expected.url &&
    existing.description === expected.description &&
    existing.color === expected.color &&
    existing.thumbnail?.url === expected.thumbnail?.url
  );
}

function buildAboutEmbed(
  demo: NonNullable<Awaited<ReturnType<typeof getChronoteDemo>>>,
  servers: number,
): APIEmbed {
  const serversLabel = `${formatCount.format(servers)} servers`;
  const stats = demo.stats
    ? `${serversLabel} · ${formatCount.format(demo.stats.completedMeetings)} meetings · ${formatCount.format(demo.stats.recordedHours)} hours`
    : serversLabel;
  return {
    title: ABOUT_TITLE,
    url: ABOUT_URL,
    description: [
      `### ${stats}`,
      "Chronote records Discord voice meetings and generates transcripts and notes. Search meetings you have access to or ask questions with links back to the source.",
      "**Get started**\n[Add Chronote](https://chronote.gg/join) · [Open portal](https://chronote.gg/portal) · [Docs](https://docs.chronote.gg/)",
      `**Try the demo**\nJoining <#${demo.voiceChannelId}> starts recording automatically. Talk about a made-up topic, then end the recording to see your notes in <#${demo.outputChannelId}>.`,
      demo.supportChannelId &&
        `**Need help?**\nAsk in <#${demo.supportChannelId}>.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    color: 0x6f75ff,
    thumbnail: { url: "https://chronote.gg/logo192.png" },
  };
}
