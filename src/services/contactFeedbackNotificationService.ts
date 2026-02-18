import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "./configService";
import type { ContactFeedbackRecord } from "../types/db";

export async function notifyContactFeedback(
  client: Client,
  record: ContactFeedbackRecord,
): Promise<void> {
  const channelId = config.contactFeedback.notificationChannelId;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

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
      record.message.length > 1024
        ? record.message.slice(0, 1021) + "..."
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

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (error) {
    console.error("Failed to send contact feedback notification", error);
  }
}
