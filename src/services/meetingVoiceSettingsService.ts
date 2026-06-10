import { CONFIG_KEYS } from "../config/keys";
import type { TierLimits } from "./subscriptionService";
import {
  getSnapshotBoolean,
  getSnapshotEnum,
  getSnapshotString,
  resolveConfigSnapshot,
} from "./unifiedConfigService";
import {
  CHAT_TTS_SPEAKER_PREFIX_MODES,
  DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE,
  type ChatTtsSpeakerPrefixMode,
} from "../utils/ttsText";

export type MeetingVoiceSettings = {
  liveVoiceEnabled: boolean;
  liveVoiceCommandsEnabled: boolean;
  chatTtsEnabled: boolean;
  chatTtsTtsOnlyEnabled: boolean;
  liveVoiceTtsVoice?: string;
  chatTtsVoice?: string;
  chatTtsSpeakerPrefixMode: ChatTtsSpeakerPrefixMode;
};

export async function resolveMeetingVoiceSettings(
  guildId: string,
  channelId: string,
  limits: TierLimits,
): Promise<MeetingVoiceSettings> {
  const snapshot = await resolveConfigSnapshot({ guildId, channelId });
  const liveVoiceEnabledRaw = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.liveVoice.enabled,
  );
  const liveVoiceCommandsRaw = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.liveVoice.commandsEnabled,
  );
  const chatTtsEnabledRaw = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.chatTts.enabled,
  );
  const chatTtsTtsOnlyEnabledRaw = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.chatTts.ttsOnlyEnabled,
  );
  const liveVoiceEnabled = limits.liveVoiceEnabled && liveVoiceEnabledRaw;
  const liveVoiceCommandsEnabled =
    limits.liveVoiceEnabled && liveVoiceCommandsRaw;
  const chatTtsEnabled = limits.liveVoiceEnabled && chatTtsEnabledRaw;
  const chatTtsTtsOnlyEnabled =
    limits.liveVoiceEnabled && chatTtsTtsOnlyEnabledRaw;
  const liveVoiceTtsVoice = getSnapshotString(
    snapshot,
    CONFIG_KEYS.liveVoice.ttsVoice,
    { trim: true },
  );
  const chatTtsVoice = getSnapshotString(snapshot, CONFIG_KEYS.chatTts.voice, {
    trim: true,
  });
  const chatTtsSpeakerPrefixMode =
    getSnapshotEnum(
      snapshot,
      CONFIG_KEYS.chatTts.speakerPrefixMode,
      CHAT_TTS_SPEAKER_PREFIX_MODES,
      DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE,
    ) ?? DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE;
  return {
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    chatTtsEnabled,
    chatTtsTtsOnlyEnabled,
    liveVoiceTtsVoice,
    chatTtsVoice,
    chatTtsSpeakerPrefixMode,
  };
}
