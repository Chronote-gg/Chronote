import { nowIso } from "../utils/time";
import { getUserSpeechSettingsRepository } from "../repositories/userSpeechSettingsRepository";
import type { UserSpeechSettings } from "../types/db";

export type UserSpeechSettingsUpdate = {
  chatTtsDisabled?: boolean;
  chatTtsVoice?: string | null;
  chatTtsSpokenName?: string | null;
  chatTtsSpeakerPrefixMode?: "never" | "chat_only" | "always" | null;
  chatTtsVolumePercent?: number | null;
};

const resolveNullableSetting = <T>(
  existingValue: T | undefined,
  updateValue: T | null | undefined,
) => (updateValue === null ? undefined : (updateValue ?? existingValue));

export function buildUserSpeechSettingsRecord(options: {
  guildId: string;
  userId: string;
  updatedBy: string;
  existing?: UserSpeechSettings | null;
  update: UserSpeechSettingsUpdate;
}): UserSpeechSettings | undefined {
  const { guildId, userId, updatedBy, existing, update } = options;
  const disabled = update.chatTtsDisabled ?? existing?.chatTtsDisabled;
  const voice = resolveNullableSetting(
    existing?.chatTtsVoice,
    update.chatTtsVoice,
  );
  const spokenName = resolveNullableSetting(
    existing?.chatTtsSpokenName,
    update.chatTtsSpokenName,
  );
  const speakerPrefixMode = resolveNullableSetting(
    existing?.chatTtsSpeakerPrefixMode,
    update.chatTtsSpeakerPrefixMode,
  );
  const volumePercent = resolveNullableSetting(
    existing?.chatTtsVolumePercent,
    update.chatTtsVolumePercent,
  );

  if (
    !disabled &&
    !voice &&
    !spokenName &&
    !speakerPrefixMode &&
    volumePercent === undefined
  ) {
    return undefined;
  }

  return {
    guildId,
    userId,
    updatedAt: nowIso(),
    updatedBy,
    ...(disabled ? { chatTtsDisabled: true } : {}),
    ...(voice ? { chatTtsVoice: voice } : {}),
    ...(spokenName ? { chatTtsSpokenName: spokenName } : {}),
    ...(speakerPrefixMode
      ? { chatTtsSpeakerPrefixMode: speakerPrefixMode }
      : {}),
    ...(volumePercent !== undefined
      ? { chatTtsVolumePercent: volumePercent }
      : {}),
  };
}

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
  const next = buildUserSpeechSettingsRecord({
    guildId,
    userId,
    updatedBy,
    existing,
    update,
  });
  if (!next) {
    if (existing) {
      await repo.remove(guildId, userId);
    }
    return;
  }

  await repo.write(next);
}
