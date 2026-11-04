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

type UpdatableInteractionLike = {
  deferUpdate(): Promise<unknown>;
};

/**
 * discord.js reports `deferred` for a deferred reply and a deferred update
 * alike, but a deferred update's `editReply` targets the component's own
 * message, so a notice delivered that way overwrites a message the whole
 * channel can see. Component handlers here use both kinds of defer, so the kind
 * cannot be inferred from the interaction and is recorded when it is chosen.
 */
const deferredUpdates = new WeakSet<object>();

/**
 * Defers a component interaction as an update, so a later notice follows up
 * instead of overwriting the message the component belongs to. Prefer this over
 * calling `deferUpdate` directly.
 */
export async function deferInteractionUpdate(
  interaction: UpdatableInteractionLike,
): Promise<void> {
  await interaction.deferUpdate();
  deferredUpdates.add(interaction);
}

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
    if (interaction.replied || deferredUpdates.has(interaction))
      await interaction.followUp(payload);
    else if (interaction.deferred) await interaction.editReply(payload);
    else await interaction.reply(payload);
    return true;
  } catch (error) {
    console.error("Failed to deliver interaction notice", error);
    return false;
  }
}
