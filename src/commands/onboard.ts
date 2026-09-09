import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildBasedChannel,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  fetchOnboardingState,
  removeOnboardingState,
  saveOnboardingState,
} from "../services/onboardingService";
import { AutoRecordSettings } from "../types/db";
import { config } from "../services/configService";
import { CONFIG_KEYS } from "../config/keys";
import {
  fetchGuildInstallerForMembership,
  saveGuildInstallerForMembership,
} from "../services/guildInstallerService";
import { setConfigOverrideForScope } from "../services/configOverridesService";
import { saveAutoRecordSetting } from "../services/autorecordService";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

export const onboardCommand = new SlashCommandBuilder()
  .setName("onboard")
  .setDescription("Quickly set up Meeting Notes bot for this server");

type OnboardButtonId =
  | "onboard_ctx_modal"
  | "onboard_auto_off"
  | "onboard_auto_one"
  | "onboard_auto_all"
  | "onboard_skip_autorecord"
  | "onboard_skip_tour"
  | "onboard_next_upgrade"
  | "onboard_skip_upgrade";

const DOCS_LINK =
  config.frontend.siteUrl ||
  config.stripe.billingLandingUrl ||
  "https://example.com";
const PRICING_LINK = config.stripe.billingLandingUrl || DOCS_LINK;
const BILLING_PORTAL_LINK = `${config.frontend.siteUrl || ""}/billing`;

function nowIso() {
  return new Date().toISOString();
}

async function saveState(
  guildId: string,
  userId: string,
  updates: Partial<{
    step: "context" | "autorecord" | "tour" | "upgrade" | "complete";
    contextDescription?: string;
    toneNotes?: string;
    autorecordMode?: "off" | "one" | "all";
    autorecordVoiceChannelId?: string;
    autorecordTextChannelId?: string;
  }>,
) {
  const current = await fetchOnboardingState(guildId, userId);
  const ttl = Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
  await saveOnboardingState({
    guildId,
    userId,
    step: updates.step ?? current?.step ?? "context",
    contextDescription:
      updates.contextDescription ?? current?.contextDescription,
    toneNotes: updates.toneNotes ?? current?.toneNotes,
    autorecordMode: updates.autorecordMode ?? current?.autorecordMode,
    autorecordVoiceChannelId:
      updates.autorecordVoiceChannelId ?? current?.autorecordVoiceChannelId,
    autorecordTextChannelId:
      updates.autorecordTextChannelId ?? current?.autorecordTextChannelId,
    updatedAt: nowIso(),
    ttl,
  });
}

function buildContextMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Welcome! Let's get set up")
    .setDescription(
      "Step 1/4: Add a short server description and tone so notes sound right. Takes ~1 minute total.",
    );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard_ctx_modal")
      .setLabel("Add context")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("onboard_skip_autorecord")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

function buildAutorecordComponents(
  guildVoice: GuildBasedChannel | undefined,
  textChannel: GuildBasedChannel | undefined,
) {
  const voiceSelect = new ChannelSelectMenuBuilder()
    .setCustomId("onboard_voice")
    .setPlaceholder("Choose a voice channel")
    .addChannelTypes(ChannelType.GuildVoice)
    .setMinValues(1)
    .setMaxValues(1);
  const textSelect = new ChannelSelectMenuBuilder()
    .setCustomId("onboard_text")
    .setPlaceholder("Choose a text channel for notifications")
    .addChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard_auto_one")
      .setLabel("Enable for selected voice")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("onboard_auto_all")
      .setLabel("Enable for all voice")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onboard_auto_off")
      .setLabel("Leave off")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onboard_skip_tour")
      .setLabel("Skip step")
      .setStyle(ButtonStyle.Secondary),
  );

  const rows = [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(voiceSelect),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(textSelect),
    buttons,
  ];

  if (guildVoice) voiceSelect.setDefaultChannels([guildVoice.id]);
  if (textChannel) textSelect.setDefaultChannels([textChannel.id]);

  return rows;
}

function buildAutorecordEmbed() {
  return new EmbedBuilder()
    .setTitle("Step 2/4: Auto-recording")
    .setDescription(
      "Pick a voice channel to auto-record (or leave it off). Free: 90 min / 3 per day. Paid: 2h, unlimited.",
    );
}

function buildTourMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Step 3/4: Quick tour")
    .setDescription(
      [
        "• `/startmeeting` – manual record with tags/context.",
        "• `/ask` – ask about recent meetings (free depth: 5; paid: 25).",
        "• Edit tags from start/summary embeds.",
        "• Live voice replies (enabled on paid tier).",
      ].join("\n"),
    );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setURL(DOCS_LINK)
      .setLabel("Docs / Help")
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId("onboard_next_upgrade")
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("onboard_skip_upgrade")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

function buildUpgradeMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Step 4/4: Unlock more")
    .setDescription(
      "Upgrade to remove daily limits, use live voice replies, deeper `/ask`, and image generation.",
    );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setURL(PRICING_LINK || DOCS_LINK)
      .setLabel("See pricing / Upgrade")
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setURL(BILLING_PORTAL_LINK)
      .setLabel("Billing portal")
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId("onboard_skip_upgrade")
      .setLabel("Done")
      .setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [buttons] };
}

export async function handleOnboardCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const hasManageGuild =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
    false;
  const installer = await fetchGuildInstallerForMembership(
    guild.id,
    guild.joinedTimestamp,
  );
  const isInstaller = installer?.installerId === interaction.user.id;

  if (!hasManageGuild && !isInstaller) {
    await interaction.reply({
      content: "You need Manage Guild permission to run onboarding.",
      ephemeral: true,
    });
    return;
  }

  if (!installer) {
    await saveGuildInstallerForMembership(
      {
        guildId: guild.id,
        installerId: interaction.user.id,
        installedAt: nowIso(),
      },
      guild.joinedTimestamp,
    );
  }

  const state = await fetchOnboardingState(guild.id, interaction.user.id);
  const step = state?.step ?? "context";

  if (step === "complete") {
    await interaction.reply({
      content:
        "Onboarding is already marked complete. Run again to redo settings.",
      ephemeral: true,
    });
    return;
  }

  if (step === "context") {
    await saveState(guild.id, interaction.user.id, { step: "context" });
    await interaction.reply({
      ephemeral: true,
      ...buildContextMessage(),
    });
    return;
  }

  if (step === "autorecord") {
    const firstVoice = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildVoice,
    );
    const firstText = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText,
    );
    if (firstVoice || firstText) {
      await saveState(guild.id, interaction.user.id, {
        autorecordVoiceChannelId: firstVoice?.id,
        autorecordTextChannelId: firstText?.id,
      });
    }
    await interaction.reply({
      ephemeral: true,
      embeds: [buildAutorecordEmbed()],
      components: buildAutorecordComponents(firstVoice, firstText),
    });
    return;
  }

  if (step === "tour") {
    await interaction.reply({ ephemeral: true, ...buildTourMessage() });
    return;
  }

  if (step === "upgrade") {
    await interaction.reply({ ephemeral: true, ...buildUpgradeMessage() });
    return;
  }
}

export function isOnboardButton(customId: string): customId is OnboardButtonId {
  return (
    customId.startsWith("onboard_auto_") ||
    customId === "onboard_ctx_modal" ||
    customId === "onboard_skip_autorecord" ||
    customId === "onboard_skip_tour" ||
    customId === "onboard_next_upgrade" ||
    customId === "onboard_skip_upgrade"
  );
}

export function isOnboardModal(customId: string) {
  return customId === "onboard_context_modal";
}

export function isOnboardChannelSelect(customId: string) {
  return customId === "onboard_voice" || customId === "onboard_text";
}

export async function handleOnboardModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId !== "onboard_context_modal") return;
  const guild = interaction.guild;
  if (!guild) return;

  const description =
    interaction.fields.getTextInputValue("server_description");
  const tone = interaction.fields.getTextInputValue("tone_notes");
  const combined = tone ? `${description}\n\nTone: ${tone}` : description;

  await setConfigOverrideForScope(
    { scope: "server", guildId: guild.id },
    CONFIG_KEYS.context.instructions,
    combined.trim(),
    interaction.user.id,
  );

  await saveState(guild.id, interaction.user.id, {
    step: "autorecord",
    contextDescription: description,
    toneNotes: tone,
  });

  await interaction.reply({
    ephemeral: true,
    content: "Saved server context. Next: auto-recording.",
    embeds: [buildAutorecordEmbed()],
    components: buildAutorecordComponents(
      guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice),
      guild.channels.cache.find((c) => c.type === ChannelType.GuildText),
    ),
  });
}

export async function handleOnboardButtonInteraction(
  interaction: ButtonInteraction,
) {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const customId = interaction.customId as OnboardButtonId;

  if (customId === "onboard_ctx_modal") {
    const modal = new ModalBuilder()
      .setCustomId("onboard_context_modal")
      .setTitle("Server context");
    const desc = new TextInputBuilder()
      .setCustomId("server_description")
      .setLabel("Describe this server (1-2 lines)")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(true);
    const tone = new TextInputBuilder()
      .setCustomId("tone_notes")
      .setLabel("Tone/style notes (optional)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(desc),
      new ActionRowBuilder<TextInputBuilder>().addComponents(tone),
    );
    await interaction.showModal(modal);
    return;
  }

  if (customId === "onboard_auto_off") {
    await saveState(guildId, userId, { step: "tour", autorecordMode: "off" });
    await interaction.update({ ...buildTourMessage() });
    return;
  }

  if (customId === "onboard_auto_one" || customId === "onboard_auto_all") {
    const state = await fetchOnboardingState(guildId, userId);
    const voiceId = state?.autorecordVoiceChannelId;
    const textId = state?.autorecordTextChannelId;
    if (!textId || (customId === "onboard_auto_one" && !voiceId)) {
      await interaction.reply({
        ephemeral: true,
        content:
          "Select a voice channel and a text channel first, then try again.",
      });
      return;
    }
    const setting: AutoRecordSettings =
      customId === "onboard_auto_all"
        ? {
            guildId,
            channelId: "ALL",
            textChannelId: textId,
            enabled: true,
            recordAll: true,
            createdBy: userId,
            createdAt: nowIso(),
          }
        : {
            guildId,
            channelId: voiceId!,
            textChannelId: textId,
            enabled: true,
            recordAll: false,
            createdBy: userId,
            createdAt: nowIso(),
          };
    await saveAutoRecordSetting({
      guildId: setting.guildId,
      channelId: setting.channelId,
      textChannelId: setting.textChannelId,
      enabled: setting.enabled,
      recordAll: setting.recordAll,
      createdBy: setting.createdBy,
      tags: setting.tags,
    });
    await saveState(guildId, userId, {
      step: "tour",
      autorecordMode: customId === "onboard_auto_all" ? "all" : "one",
    });
    await interaction.update({
      ...buildTourMessage(),
      content: "Auto-record saved. Next up: quick tour.",
    });
    return;
  }

  if (customId === "onboard_skip_autorecord") {
    await saveState(guildId, userId, { step: "autorecord" });
    await interaction.reply({
      ephemeral: true,
      embeds: [buildAutorecordEmbed()],
      components: buildAutorecordComponents(
        interaction.guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildVoice,
        ),
        interaction.guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText,
        ),
      ),
    });
    return;
  }

  if (customId === "onboard_skip_tour") {
    await saveState(guildId, userId, { step: "tour" });
    await interaction.update({ ...buildTourMessage() });
    return;
  }

  if (customId === "onboard_next_upgrade") {
    await saveState(guildId, userId, { step: "upgrade" });
    await interaction.update({ ...buildUpgradeMessage() });
    return;
  }

  if (customId === "onboard_skip_upgrade") {
    await saveState(guildId, userId, { step: "complete" });
    await removeOnboardingState(guildId, userId);
    await interaction.update({
      content: "Onboarding finished. You can rerun `/onboard` anytime.",
      components: [],
      embeds: [],
    });
  }
}

export async function handleOnboardChannelSelect(
  interaction: ChannelSelectMenuInteraction,
) {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const selectedId = interaction.values[0];

  if (interaction.customId === "onboard_voice") {
    await saveState(guildId, userId, {
      autorecordVoiceChannelId: selectedId,
      step: "autorecord",
    });
    await interaction.reply({
      ephemeral: true,
      content: `Voice channel set to <#${selectedId}>. Choose a text channel and click enable.`,
    });
    return;
  }

  if (interaction.customId === "onboard_text") {
    await saveState(guildId, userId, {
      autorecordTextChannelId: selectedId,
      step: "autorecord",
    });
    await interaction.reply({
      ephemeral: true,
      content: `Text channel set to <#${selectedId}>. Choose voice + click enable.`,
    });
  }
}
