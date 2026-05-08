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
  if (interaction.targetUser.id !== client.user?.id) {
    await interaction.reply({
      content: "Right-click Chronote to start a meeting.",
      ephemeral: true,
    });
    return;
  }

  await handleRequestStartMeeting(interaction);
}
