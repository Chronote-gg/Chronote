export const CHAT_TTS_SPEAKER_PREFIX_MODES = [
  "never",
  "chat_only",
  "always",
] as const;

export const USER_CHAT_TTS_SPEAKER_PREFIX_MODES = [
  "default",
  ...CHAT_TTS_SPEAKER_PREFIX_MODES,
] as const;

export type ChatTtsSpeakerPrefixMode =
  (typeof CHAT_TTS_SPEAKER_PREFIX_MODES)[number];

export type UserChatTtsSpeakerPrefixMode =
  (typeof USER_CHAT_TTS_SPEAKER_PREFIX_MODES)[number];

export type TtsSpeechContext = "chat" | "say";

export const DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE =
  "chat_only" satisfies ChatTtsSpeakerPrefixMode;

export const CHAT_TTS_SPEAKER_PREFIX_MODE_OPTIONS = [
  { label: "Never", value: "never" },
  { label: "Automatic chat only", value: "chat_only" },
  { label: "Always", value: "always" },
] as const;

export const USER_CHAT_TTS_SPEAKER_PREFIX_MODE_OPTIONS = [
  { label: "Default (server)", value: "default" },
  ...CHAT_TTS_SPEAKER_PREFIX_MODE_OPTIONS,
] as const;

export function normalizeChatTtsSpeakerPrefixMode(
  value: string | null | undefined,
): ChatTtsSpeakerPrefixMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return (CHAT_TTS_SPEAKER_PREFIX_MODES as readonly string[]).includes(
    normalized,
  )
    ? (normalized as ChatTtsSpeakerPrefixMode)
    : undefined;
}

export function normalizeUserChatTtsSpeakerPrefixMode(
  value: string | null | undefined,
): UserChatTtsSpeakerPrefixMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return (USER_CHAT_TTS_SPEAKER_PREFIX_MODES as readonly string[]).includes(
    normalized,
  )
    ? (normalized as UserChatTtsSpeakerPrefixMode)
    : undefined;
}

export function resolveChatTtsSpeakerPrefixMode(
  userMode: string | null | undefined,
  fallbackMode: string | null | undefined,
): ChatTtsSpeakerPrefixMode {
  return (
    normalizeChatTtsSpeakerPrefixMode(userMode) ||
    normalizeChatTtsSpeakerPrefixMode(fallbackMode) ||
    DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE
  );
}

function shouldPrefixSpeech(
  context: TtsSpeechContext,
  mode: ChatTtsSpeakerPrefixMode,
) {
  if (mode === "always") return true;
  if (mode === "chat_only") return context === "chat";
  return false;
}

export function buildTtsSpeechText(input: {
  message: string;
  speakerName?: string;
  prefixMode: ChatTtsSpeakerPrefixMode;
  context: TtsSpeechContext;
}): string {
  const message = input.message.trim();
  const speakerName = input.speakerName?.trim();
  if (!speakerName || !shouldPrefixSpeech(input.context, input.prefixMode)) {
    return message;
  }
  return `${speakerName} said ${message}`;
}
