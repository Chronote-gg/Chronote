import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH } from "../constants";
import { submitContactFeedback } from "../services/contactFeedbackService";
import { notifyContactFeedback } from "../services/contactFeedbackNotificationService";

const CONTACT_FEEDBACK_MODAL_PREFIX = "contact_feedback_modal_";

export function isContactFeedbackModal(customId: string): boolean {
  return customId.startsWith(CONTACT_FEEDBACK_MODAL_PREFIX);
}

export async function handleFeedbackCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${CONTACT_FEEDBACK_MODAL_PREFIX}${interaction.user.id}`)
    .setTitle("Send Feedback");

  const messageInput = new TextInputBuilder()
    .setCustomId("feedback_message")
    .setLabel("Your feedback, question, or bug report")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(
      "Tell us what you think, report a bug, or suggest a feature...",
    )
    .setRequired(true)
    .setMaxLength(CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH);

  const contactInput = new TextInputBuilder()
    .setCustomId("feedback_contact")
    .setLabel("Contact info for follow-up (optional)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Email or Discord tag")
    .setRequired(false)
    .setMaxLength(200);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(contactInput),
  );

  await interaction.showModal(modal);
}

export async function handleContactFeedbackModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const message = interaction.fields.getTextInputValue("feedback_message");
  const contact =
    interaction.fields.getTextInputValue("feedback_contact") || undefined;

  try {
    const record = await submitContactFeedback({
      source: "discord",
      message,
      contactDiscord: contact,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      displayName: interaction.user.globalName ?? interaction.user.displayName,
      guildId: interaction.guildId ?? undefined,
    });

    await interaction.editReply(
      "Thank you for your feedback! We appreciate you taking the time to share your thoughts.",
    );

    if (interaction.client) {
      await notifyContactFeedback(interaction.client, record);
    }
  } catch (error) {
    console.error("Failed to submit contact feedback from Discord", error);
    await interaction.editReply(
      "Something went wrong submitting your feedback. Please try again later.",
    );
  }
}
