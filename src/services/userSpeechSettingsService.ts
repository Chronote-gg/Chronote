import { nowIso } from "../utils/time";
import { getUserSpeechSettingsRepository } from "../repositories/userSpeechSettingsRepository";
import type { UserSpeechSettings } from "../types/db";

export type UserSpeechSettingsUpdate = {
  chatTtsDisabled?: boolean;
  chatTtsVoice?: string | null;
  chatTtsSpokenName?: string | null;
  chatTtsSpeakerPrefixMode?: "never" | "chat_only" | "always" | null;
};

export async function fetchUserSpeechSettings(
  guildId: string,
  userId: string,
): Promise<UserSpeechSettings | undefined> {
  return getUserSpeechSettingsRepository().get(guildId, userId);
}

export async function setUserSpeechSettings(
  guildId: string,
  userId: string,
  updatedBy: string,
  update: UserSpeechSettingsUpdate,
): Promise<void> {
  const repo = getUserSpeechSettingsRepository();
  const existing = await repo.get(guildId, userId);
  const nextDisabled =
    update.chatTtsDisabled !== undefined
      ? update.chatTtsDisabled
      : existing?.chatTtsDisabled;
  const nextVoice =
    update.chatTtsVoice === null
      ? undefined
      : (update.chatTtsVoice ?? existing?.chatTtsVoice);
  const nextSpokenName =
    update.chatTtsSpokenName === null
      ? undefined
      : (update.chatTtsSpokenName ?? existing?.chatTtsSpokenName);
  const nextSpeakerPrefixMode =
    update.chatTtsSpeakerPrefixMode === null
      ? undefined
      : (update.chatTtsSpeakerPrefixMode ?? existing?.chatTtsSpeakerPrefixMode);

  if (
    !nextDisabled &&
    !nextVoice &&
    !nextSpokenName &&
    !nextSpeakerPrefixMode
  ) {
    if (existing) {
      await repo.remove(guildId, userId);
    }
    return;
  }

  const next: UserSpeechSettings = {
    guildId,
    userId,
    updatedAt: nowIso(),
    updatedBy,
    ...(nextDisabled ? { chatTtsDisabled: true } : {}),
    ...(nextVoice ? { chatTtsVoice: nextVoice } : {}),
    ...(nextSpokenName ? { chatTtsSpokenName: nextSpokenName } : {}),
    ...(nextSpeakerPrefixMode
      ? { chatTtsSpeakerPrefixMode: nextSpeakerPrefixMode }
      : {}),
  };
  await repo.write(next);
}
