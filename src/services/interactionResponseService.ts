import type {
  InteractionEditReplyOptions,
  InteractionReplyOptions,
} from "discord.js";

/** A notice must be valid on every delivery route, so it satisfies all of them. */
type InteractionReplyPayload =
  string | (InteractionReplyOptions & InteractionEditReplyOptions);

type ReplyableInteractionLike = {
  deferred: boolean;
  replied: boolean;
  reply(payload: InteractionReplyPayload): Promise<unknown>;
  editReply(payload: InteractionReplyPayload): Promise<unknown>;
  followUp(payload: InteractionReplyPayload): Promise<unknown>;
};

/**
 * Delivers a notice on whichever route the interaction's current state allows,
 * so a deferred interaction resolves instead of showing "thinking" forever.
 * Never throws: an expired or consumed token must not mask an original error.
 */
export async function sendInteractionNotice(
  interaction: ReplyableInteractionLike,
  payload: InteractionReplyPayload,
): Promise<boolean> {
  try {
    if (interaction.replied) await interaction.followUp(payload);
    else if (interaction.deferred) await interaction.editReply(payload);
    else await interaction.reply(payload);
    return true;
  } catch (error) {
    console.error("Failed to deliver interaction notice", error);
    return false;
  }
}
