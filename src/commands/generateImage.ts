import { getImage } from "../services/imageService";
import { ButtonInteraction, EmbedBuilder } from "discord.js";
import { getMeeting } from "../meetings";
import { getGuildLimits } from "../services/subscriptionService";
import { buildUpgradePrompt } from "../utils/upgradePrompt";

export async function generateAndSendImage(
  interaction: ButtonInteraction,
  signal?: AbortSignal,
) {
  const meeting = getMeeting(interaction.guildId!);

  if (!meeting) {
    signal?.throwIfAborted();
    await interaction.reply("Meeting data has already been cleaned up, sorry!");
    return;
  }

  const { limits } = await getGuildLimits(interaction.guildId);
  if (!limits.imagesEnabled) {
    signal?.throwIfAborted();
    await interaction.reply(
      buildUpgradePrompt(
        "Image generation is available on the Basic plan. Upgrade to generate meeting images.",
      ),
    );
    return;
  }

  signal?.throwIfAborted();
  await interaction.deferReply();

  signal?.throwIfAborted();
  const imageUrl = await getImage(meeting, signal);

  if (imageUrl) {
    signal?.throwIfAborted();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Meeting Image").setImage(imageUrl)],
    });
  } else {
    signal?.throwIfAborted();
    await interaction.editReply({
      content: "No action items detected within transcript.",
    });
  }
}
