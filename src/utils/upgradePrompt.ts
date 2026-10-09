import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionReplyOptions,
} from "discord.js";
import { config } from "../services/configService";
import type { PurchaseSource } from "./purchaseAnalytics";

function upgradeLink(source?: PurchaseSource): string {
  const link = config.stripe.billingLandingUrl;
  if (!link || !source) return link;
  const url = new URL(link);
  url.searchParams.set("source", source);
  return url.toString();
}

export function buildUpgradePrompt(
  content: string,
): InteractionReplyOptions & { ephemeral?: boolean } {
  const link = upgradeLink("discord_limit");
  const upgradeBtn =
    link &&
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Upgrade")
      .setURL(link);

  return {
    content,
    components: upgradeBtn
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(upgradeBtn)]
      : [],
    ephemeral: true,
  };
}

export function buildUpgradeTextOnly(
  content: string,
  source?: PurchaseSource,
): string {
  const link = upgradeLink(source);
  if (!link) return content;
  return `${content}\nUpgrade: ${link}`;
}
