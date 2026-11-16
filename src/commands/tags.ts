import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from "discord.js";
import { getMeeting } from "../meetings";
import { normalizeTags, parseTags, topTags } from "../utils/tags";
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
  updateMeetingTagsService,
} from "../services/meetingHistoryService";

import {
  EDIT_TAGS_BUTTON_ID,
  EDIT_TAGS_MODAL_ID as TAG_MODAL_ID,
} from "../botInteractionScope";

const TAG_INPUT_ID = "tags_input";
const TAG_HISTORY_PREFIX = "edit_tags_history";

export function isEditTagsButton(customId: string) {
  return customId === EDIT_TAGS_BUTTON_ID;
}

export function isEditTagsModal(customId: string) {
  return customId === TAG_MODAL_ID;
}

export function isEditTagsHistoryButton(customId: string) {
  return customId.startsWith(`${TAG_HISTORY_PREFIX}:`);
}

export function isEditTagsHistoryModal(customId: string) {
  return customId.startsWith(`${TAG_HISTORY_PREFIX}_modal:`);
}

export async function handleEditTagsButton(interaction: ButtonInteraction) {
  const meeting = interaction.guildId ? getMeeting(interaction.guildId) : null;
  const currentTags = meeting?.tags?.join(", ") ?? "";
  const basePlaceholder = currentTags.length
    ? currentTags
    : "e.g., sprint, ttrpg, Q1-planning";

  let suggested = "";
  if (interaction.guildId) {
    try {
      const recent = await listRecentMeetingsForGuildService(
        interaction.guildId,
        50,
      );
      const top = topTags(recent, 8);
      if (top.length) {
        suggested = `Common tags: ${top.join(", ")}`;
      }
    } catch (e) {
      console.warn("Could not load tag suggestions", e);
    }
  }

  const hint = suggested ? ` | ${suggested}`.slice(0, 90) : "";
  const textInput = new TextInputBuilder()
    .setCustomId(TAG_INPUT_ID)
    .setLabel("Tags (comma-separated)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder(basePlaceholder + hint);

  const modal = new ModalBuilder()
    .setCustomId(TAG_MODAL_ID)
    .setTitle("Edit Tags")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
    );

  await interaction.showModal(modal);
}

export async function handleEditTagsModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const meeting = interaction.guildId ? getMeeting(interaction.guildId) : null;
  if (!meeting) {
    await interaction.reply({
      content: "No active meeting found.",
      ephemeral: true,
    });
    return;
  }

  const raw = interaction.fields.getTextInputValue(TAG_INPUT_ID);
  const tags = normalizeTags(parseTags(raw)) || [];
  meeting.tags = tags.length ? tags : undefined;

  await updateStartMessageTags(meeting);

  await interaction.reply({
    content: tags.length ? `Tags updated: ${tags.join(", ")}` : "Tags cleared.",
    ephemeral: true,
  });
}

export async function handleEditTagsHistoryButton(
  interaction: ButtonInteraction,
) {
  const parts = interaction.customId.split(":");
  const encoded = parts[2];
  const channelIdTimestamp = Buffer.from(encoded, "base64").toString("utf-8");

  const history = await getMeetingHistoryService(
    interaction.guildId!,
    channelIdTimestamp,
  );
  const currentTags = history?.tags?.join(", ") ?? "";

  const modal = new ModalBuilder()
    .setCustomId(`${TAG_HISTORY_PREFIX}_modal:${encoded}`)
    .setTitle("Edit Meeting Tags")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TAG_INPUT_ID)
          .setLabel("Tags (comma-separated)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder(
            currentTags.length
              ? currentTags
              : "e.g., sprint, ttrpg, Q1-planning",
          ),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleEditTagsHistoryModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [, encoded] = interaction.customId.split(":");
  const channelIdTimestamp = Buffer.from(encoded, "base64").toString("utf-8");

  const raw = interaction.fields.getTextInputValue(TAG_INPUT_ID);
  const tags = normalizeTags(parseTags(raw)) || [];

  await updateMeetingTagsService(
    interaction.guildId!,
    channelIdTimestamp,
    tags.length ? tags : [],
  );

  await interaction.reply({
    content: tags.length ? `Tags updated: ${tags.join(", ")}` : "Tags cleared.",
    ephemeral: true,
  });
}

async function updateStartMessageTags(meeting: ReturnType<typeof getMeeting>) {
  if (!meeting || !meeting.startMessageId) return;
  try {
    const message = await meeting.textChannel.messages.fetch(
      meeting.startMessageId,
    );
    const embed = message.embeds[0];
    if (!embed) return;

    const fields = embed.data.fields ?? [];
    const filtered = fields.filter((f) => f.name !== "Tags");
    if (meeting.tags && meeting.tags.length > 0) {
      filtered.push({
        name: "Tags",
        value: meeting.tags.join(", "),
        inline: true,
      });
    }

    await message.edit({
      embeds: [
        {
          ...embed.data,
          fields: filtered,
        },
      ],
      components: message.components,
    });
  } catch (e) {
    console.warn("Could not update start message tags", e);
  }
}
