import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { config } from "../services/configService";

async function replyRetiredOnboarding(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | ChannelSelectMenuInteraction,
): Promise<void> {
  const base = config.frontend.siteUrl.replace(/\/$/, "");
  const portalPath = interaction.guildId
    ? `/portal/meetings?scope=guild&serverId=${encodeURIComponent(interaction.guildId)}`
    : "/portal";
  await interaction.reply({
    content: "Setup is now in the portal.",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel("Open portal")
          .setStyle(ButtonStyle.Link)
          .setURL(`${base}${portalPath}`),
      ),
    ],
  });
}

export const handleOnboardCommand = replyRetiredOnboarding;

export function isOnboardButton(customId: string): boolean {
  return (
    customId.startsWith("onboard_auto_") ||
    customId === "onboard_ctx_modal" ||
    customId === "onboard_skip_autorecord" ||
    customId === "onboard_skip_tour" ||
    customId === "onboard_next_upgrade" ||
    customId === "onboard_skip_upgrade"
  );
}

export function isOnboardModal(customId: string): boolean {
  return customId === "onboard_context_modal";
}

export function isOnboardChannelSelect(customId: string): boolean {
  return customId === "onboard_voice" || customId === "onboard_text";
}

export async function handleOnboardModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (isOnboardModal(interaction.customId)) {
    await replyRetiredOnboarding(interaction);
  }
}

export async function handleOnboardButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (isOnboardButton(interaction.customId)) {
    await replyRetiredOnboarding(interaction);
  }
}

export async function handleOnboardChannelSelect(
  interaction: ChannelSelectMenuInteraction,
): Promise<void> {
  if (isOnboardChannelSelect(interaction.customId)) {
    await replyRetiredOnboarding(interaction);
  }
}
