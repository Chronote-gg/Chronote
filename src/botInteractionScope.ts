import type { RepliableInteraction } from "discord.js";
import { DISMISS_AUTORECORD_COMMAND_NAME } from "./commands/dismissAutoRecord";

export const END_MEETING_BUTTON_ID = "end_meeting";
export const GENERATE_IMAGE_BUTTON_ID = "generate_image";
export const EDIT_TAGS_BUTTON_ID = "edit_tags";
export const EDIT_TAGS_MODAL_ID = "edit_tags_modal";

/** Controls that end a live session. With nothing live, they are told the recording ended. */
export const OWNER_CONTROLS = {
  buttons: [END_MEETING_BUTTON_ID],
  chatInputCommands: ["leave"],
  userContextCommands: [DISMISS_AUTORECORD_COMMAND_NAME],
} as const;

/**
 * Interactions whose handler reads or changes the live session in memory.
 * With nothing live they run their own handler, which has its own reply
 * (and `/say` may start a voice-only session).
 */
export const SESSION_SCOPED = {
  buttons: [GENERATE_IMAGE_BUTTON_ID, EDIT_TAGS_BUTTON_ID],
  modals: [EDIT_TAGS_MODAL_ID],
  chatInputCommands: ["say", "tts"],
} as const;

export type InteractionScope = "owner" | "session" | "general";

const includes = (list: readonly string[], value: string) =>
  list.includes(value);

/** A Stop recording aimed at anyone but the bot is not a control; its handler explains that. */
function isOwnerControl(interaction: RepliableInteraction): boolean {
  if (interaction.isButton())
    return includes(OWNER_CONTROLS.buttons, interaction.customId);
  if (interaction.isChatInputCommand())
    return includes(OWNER_CONTROLS.chatInputCommands, interaction.commandName);
  return (
    interaction.isUserContextMenuCommand() &&
    includes(OWNER_CONTROLS.userContextCommands, interaction.commandName) &&
    interaction.targetUser.id === interaction.client.user.id
  );
}

function isSessionScoped(interaction: RepliableInteraction): boolean {
  if (interaction.isButton())
    return includes(SESSION_SCOPED.buttons, interaction.customId);
  if (interaction.isModalSubmit())
    return includes(SESSION_SCOPED.modals, interaction.customId);
  return (
    interaction.isChatInputCommand() &&
    includes(SESSION_SCOPED.chatInputCommands, interaction.commandName)
  );
}

export function resolveInteractionScope(
  interaction: RepliableInteraction,
): InteractionScope {
  if (isOwnerControl(interaction)) return "owner";
  return isSessionScoped(interaction) ? "session" : "general";
}
