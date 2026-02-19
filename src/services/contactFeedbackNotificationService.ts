import { Client, EmbedBuilder } from "discord.js";
import { config } from "./configService";
import { getDiscordClient } from "./discordClientAccessor";
import type { ContactFeedbackRecord } from "../types/db";

const EMBED_FIELD_MAX_LENGTH = 1024;

function buildFeedbackEmbed(record: ContactFeedbackRecord): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("New Contact Feedback")
    .setColor(0x5865f2)
    .setTimestamp(new Date(record.createdAt))
    .addFields(
      { name: "Source", value: record.source, inline: true },
      {
        name: "From",
        value: record.userId
          ? `<@${record.userId}> (${record.displayName ?? record.userTag ?? "unknown"})`
          : "Anonymous",
        inline: true,
      },
    );

  if (record.contactEmail) {
    embed.addFields({
      name: "Email",
      value: record.contactEmail,
      inline: true,
    });
  }
  if (record.contactDiscord) {
    embed.addFields({
      name: "Discord",
      value: record.contactDiscord,
      inline: true,
    });
  }

  const truncatedMessage =
    record.message.length > EMBED_FIELD_MAX_LENGTH
      ? record.message.slice(0, EMBED_FIELD_MAX_LENGTH - 3) + "..."
      : record.message;
  embed.addFields({ name: "Message", value: truncatedMessage });

  if (record.imageS3Keys && record.imageS3Keys.length > 0) {
    embed.addFields({
      name: "Attachments",
      value: `${record.imageS3Keys.length} image(s)`,
      inline: true,
    });
  }

  embed.setFooter({ text: `ID: ${record.feedbackId}` });
  return embed;
}

async function sendFeedbackToChannel(
  client: Client,
  record: ContactFeedbackRecord,
): Promise<void> {
  const channelId = config.contactFeedback.notificationChannelId;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) return;

  const embed = buildFeedbackEmbed(record);
  await channel.send({ embeds: [embed] });
}

export async function notifyContactFeedback(
  client: Client,
  record: ContactFeedbackRecord,
): Promise<void> {
  try {
    await sendFeedbackToChannel(client, record);
  } catch (error) {
    console.error("Failed to send contact feedback notification", error);
  }
}

/**
 * Send a Discord notification for web-submitted feedback.
 * Uses the shared Discord client singleton (set by the bot on login).
 * No-ops gracefully if the bot is not running in this process.
 */
export async function notifyContactFeedbackFromWeb(
  record: ContactFeedbackRecord,
): Promise<void> {
  const client = getDiscordClient();
  if (!client?.isReady()) return;

  try {
    await sendFeedbackToChannel(client, record);
  } catch (error) {
    console.error(
      "Failed to send contact feedback notification from web",
      error,
    );
  }
}
