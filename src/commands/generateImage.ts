import { getImage } from "../services/imageService";
import { ButtonInteraction, EmbedBuilder } from "discord.js";
import { getMeeting } from "../meetings";
import { getGuildLimits } from "../services/subscriptionService";
import { buildUpgradePrompt } from "../utils/upgradePrompt";

export async function generateAndSendImage(interaction: ButtonInteraction) {
  const meeting = getMeeting(interaction.guildId!);

  if (!meeting) {
    await interaction.reply("Meeting data has already been cleaned up, sorry!");
    return;
  }

  const { limits } = await getGuildLimits(interaction.guildId);
  if (!limits.imagesEnabled) {
    await interaction.reply(
      buildUpgradePrompt(
        "Image generation is available on the Basic plan. Upgrade to generate meeting images.",
      ),
    );
    return;
  }

  await interaction.deferReply();

  const imageUrl = await getImage(meeting);

  if (imageUrl) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Meeting Image").setImage(imageUrl)],
    });
  } else {
    await interaction.editReply({
      content: "No action items detected within transcript.",
    });
  }
}
