import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type Client,
  type UserContextMenuCommandInteraction,
} from "discord.js";
import { handleRequestStartMeeting } from "./startMeeting";

export const START_MEETING_CONTEXT_COMMAND_NAME = "Start meeting";

export const startMeetingContextCommand = new ContextMenuCommandBuilder()
  .setName(START_MEETING_CONTEXT_COMMAND_NAME)
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

export async function handleStartMeetingContextCommand(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
) {
  const botUserId = client.user?.id;
  if (!botUserId) {
    await interaction.reply({
      content: "The bot is still starting up. Try again in a moment.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.targetUser.id !== botUserId) {
    await interaction.reply({
      content: `Right-click <@${botUserId}> to start a meeting.`,
      ephemeral: true,
    });
    return;
  }

  await handleRequestStartMeeting(interaction, { ephemeralErrors: true });
}
