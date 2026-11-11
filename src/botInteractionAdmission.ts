import type { RepliableInteraction } from "discord.js";
import type { WorkAdmissionAuthority } from "./types/deploymentControl";
import { claimInteractionReceipt } from "./services/interactionIdempotencyService";
import {
  beginRuntimeWorkClaim,
  type RuntimeWorkClaim,
  type SessionControlClosing,
} from "./services/runtimeWorkAdmissionService";

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

export const tryClaimInteraction = async (
  interaction: RepliableInteraction,
  authority: WorkAdmissionAuthority,
): Promise<boolean> => {
  try {
    return await claimInteractionReceipt({
      interactionId: interaction.id,
      interactionKind: resolveInteractionKind(interaction),
      guildId: interaction.guildId ?? undefined,
      authority,
    });
  } catch (error) {
    console.error("Failed to claim interaction receipt", {
      interactionId: interaction.id,
      error,
    });
    throw error;
  }
};

export async function respondToClosingSession(
  interaction: RepliableInteraction,
  closing: SessionControlClosing,
) {
  const deadline = interaction.createdTimestamp + 2500;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    console.warn("Closing interaction response deadline expired");
    return;
  }
  let response: RuntimeWorkClaim;
  try {
    response = beginRuntimeWorkClaim(
      "interaction_response",
      interaction.id,
      closing.reservation,
    );
  } catch {
    console.warn("Closing interaction response admission refused");
    return;
  }
  const timeout = setTimeout(() => response.fence(), remainingMs);
  await response.trackPromise(async () => {
    let receiptStarted = false;
    let receiptClaimed = false;
    let replyStarted = false;
    try {
      const authority = await response.authority();
      const claimed = await response.trackEffect(() => {
        receiptStarted = true;
        return tryClaimInteraction(interaction, authority);
      });
      if (!claimed) {
        response.acknowledgeInteractionResponseNotAdmitted();
        return;
      }
      receiptClaimed = true;
      response.acknowledgeInteractionReceipt();
      await response.trackEffect(() => {
        if (Date.now() >= deadline)
          throw new Error("Closing interaction response deadline expired");
        replyStarted = true;
        return interaction.reply({
          content:
            "This meeting is already finishing. Please wait for processing to finish.",
          ephemeral: true,
        });
      });
      response.acknowledgeInteractionResponse();
    } catch {
      if (!receiptStarted) response.acknowledgeInteractionResponseNotAdmitted();
      else if (receiptClaimed && !replyStarted)
        response.acknowledgeInteractionResponseNotStarted();
      response.fence();
      console.warn("Closing interaction response could not be confirmed");
    } finally {
      clearTimeout(timeout);
      await response.settle();
    }
  });
}
