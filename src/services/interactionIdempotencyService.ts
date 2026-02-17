import { tryCreateInteractionReceipt } from "../db";

const INTERACTION_RECEIPT_TTL_SECONDS = 60 * 60;

type ClaimInteractionInput = {
  interactionId: string;
  interactionKind: string;
  guildId?: string;
};

export async function claimInteractionReceipt({
  interactionId,
  interactionKind,
  guildId,
}: ClaimInteractionInput): Promise<boolean> {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = Math.floor(now / 1000) + INTERACTION_RECEIPT_TTL_SECONDS;

  return tryCreateInteractionReceipt({
    interactionId,
    interactionKind,
    guildId,
    createdAt,
    expiresAt,
  });
}
