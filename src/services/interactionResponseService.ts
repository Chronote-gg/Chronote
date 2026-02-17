import { InteractionReplyOptions } from "discord.js";

type InteractionReplyPayload = string | InteractionReplyOptions;

type ReplyableInteractionLike = {
  deferred: boolean;
  replied: boolean;
  reply: (payload: InteractionReplyPayload) => Promise<unknown>;
};

export async function tryReplyToUnacknowledgedInteraction(
  interaction: ReplyableInteractionLike,
  payload: InteractionReplyPayload,
): Promise<boolean> {
  if (interaction.deferred || interaction.replied) {
    return false;
  }

  await interaction.reply(payload);
  return true;
}
