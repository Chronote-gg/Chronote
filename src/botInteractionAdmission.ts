import type { RepliableInteraction } from "discord.js";
import { claimInteractionReceipt } from "./services/interactionIdempotencyService";
import { LIFECYCLE } from "./services/lifecycleTiming";

export type InteractionClaim = "claimed" | "duplicate" | "failed" | "timed_out";

export const resolveInteractionKind = (
  interaction: RepliableInteraction,
): string => {
  if (interaction.isChatInputCommand()) {
    return `chat-input:${interaction.commandName}`;
  }
  if (interaction.isUserContextMenuCommand()) {
    return `user-context:${interaction.commandName}`;
  }
  if (interaction.isButton()) {
    return `button:${interaction.customId}`;
  }
  if (interaction.isModalSubmit()) {
    return `modal:${interaction.customId}`;
  }
  if (interaction.isChannelSelectMenu()) {
    return `channel-select:${interaction.customId}`;
  }
  return "other";
};

/**
 * Never throws. Only "claimed" lets this worker respond: a failed or timed
 * out claim may have landed, and answering then could answer beside the holder.
 */
export const tryClaimInteraction = async (
  interaction: RepliableInteraction,
): Promise<InteractionClaim> => {
  // Discord allows three seconds for a first response, so a slow claim is abandoned.
  const signal = AbortSignal.timeout(LIFECYCLE.interactionReceiptClaimMs);
  try {
    const claimed = await claimInteractionReceipt({
      interactionId: interaction.id,
      interactionKind: resolveInteractionKind(interaction),
      guildId: interaction.guildId ?? undefined,
      signal,
    });
    return claimed ? "claimed" : "duplicate";
  } catch (error) {
    const timedOut = signal.aborted;
    console.warn(
      timedOut
        ? "Interaction receipt claim timed out; not responding"
        : "Interaction receipt claim failed; not responding",
      { interactionId: interaction.id, error },
    );
    return timedOut ? "timed_out" : "failed";
  }
};
