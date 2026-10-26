import { updateMeeting } from "../services/meetingUpdateService";
import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getMeetingHistoryService } from "../services/meetingHistoryService";
import {
  MEETING_NAME_REQUIREMENTS,
  normalizeMeetingName,
  resolveUniqueMeetingName,
} from "../services/meetingNameService";

const MEETING_NAME_INPUT_ID = "meeting_name_input";
const MEETING_NAME_MAX_LENGTH = 60;

export const MEETING_RENAME_PREFIX = "rename_meeting";
const MEETING_RENAME_MODAL_PREFIX = "rename_meeting_modal";

const decodeKey = (encoded: string) =>
  Buffer.from(encoded, "base64").toString("utf8");

export function isRenameMeetingButton(customId: string) {
  return customId.startsWith(`${MEETING_RENAME_PREFIX}:`);
}

export function isRenameMeetingModal(customId: string) {
  return customId.startsWith(`${MEETING_RENAME_MODAL_PREFIX}:`);
}

export async function handleRenameMeetingButton(
  interaction: ButtonInteraction,
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 3) {
    await interaction.reply({
      content: "Unable to rename this meeting right now.",
      ephemeral: true,
    });
    return;
  }
  const encoded = parts[2];
  const channelIdTimestamp = decodeKey(encoded);
  const history = await getMeetingHistoryService(
    interaction.guildId!,
    channelIdTimestamp,
  );
  if (!history) {
    await interaction.reply({
      content: "Meeting not found.",
      ephemeral: true,
    });
    return;
  }

  const currentName = history.meetingName ?? history.summaryLabel ?? "";
  const input = new TextInputBuilder()
    .setCustomId(MEETING_NAME_INPUT_ID)
    .setLabel("Meeting name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(MEETING_NAME_MAX_LENGTH)
    .setPlaceholder("e.g., Sprint planning");
  if (currentName) {
    input.setValue(currentName.slice(0, MEETING_NAME_MAX_LENGTH));
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MEETING_RENAME_MODAL_PREFIX}:${encoded}`)
    .setTitle("Rename meeting")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );

  await interaction.showModal(modal);
}

export async function handleRenameMeetingModal(
  interaction: ModalSubmitInteraction,
) {
  const parts = interaction.customId.split(":");
  if (parts.length < 2) {
    await interaction.reply({
      content: "Unable to rename this meeting right now.",
      ephemeral: true,
    });
    return;
  }

  const encoded = parts[1];
  const channelIdTimestamp = decodeKey(encoded);
  const history = await getMeetingHistoryService(
    interaction.guildId!,
    channelIdTimestamp,
  );
  if (!history) {
    await interaction.reply({
      content: "Meeting not found.",
      ephemeral: true,
    });
    return;
  }

  const rawName = interaction.fields.getTextInputValue(MEETING_NAME_INPUT_ID);
  const normalized = normalizeMeetingName(rawName);
  if (!normalized) {
    await interaction.reply({
      content: MEETING_NAME_REQUIREMENTS,
      ephemeral: true,
    });
    return;
  }

  const meetingName = await resolveUniqueMeetingName({
    guildId: interaction.guildId!,
    desiredName: normalized,
    excludeMeetingId: history.meetingId,
  });

  const saved = await updateMeeting({
    key: {
      guildId: interaction.guildId!,
      channelId_timestamp: channelIdTimestamp,
    },
    mutation: { kind: "rename", meetingName },
    actor: { editedBy: interaction.user.id },
  });
  if (saved.kind === "conflict") {
    await interaction.reply({
      content: "Unable to update this meeting name.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `Meeting name updated to **${meetingName}**.`,
    ephemeral: true,
  });
}
