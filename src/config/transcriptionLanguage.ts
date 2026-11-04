import type { ConfigEntry } from "./types";
import { CONFIG_KEYS } from "./keys";
import { z } from "zod";

// ISO-639-1 codes for the languages OpenAI lists as supported for speech to text.
export const TRANSCRIPTION_LANGUAGES = [
  "auto",
  "af",
  "ar",
  "hy",
  "az",
  "be",
  "bs",
  "bg",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "it",
  "ja",
  "kn",
  "kk",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "mi",
  "ne",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "tl",
  "ta",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "cy",
] as const;
export const transcriptionLanguageSchema = z.enum(TRANSCRIPTION_LANGUAGES);
export type TranscriptionLanguage = z.infer<typeof transcriptionLanguageSchema>;
export const DEFAULT_TRANSCRIPTION_LANGUAGE: TranscriptionLanguage = "en";

export function resolveTranscriptionLanguage(
  value: unknown,
): TranscriptionLanguage {
  return transcriptionLanguageSchema.parse(value);
}

// Live snippets and the finalized pass must share this value, or reconcile compares two languages.
export function meetingTranscriptionLanguage(runtimeConfig?: {
  transcription: { language: TranscriptionLanguage };
}): TranscriptionLanguage {
  return (
    runtimeConfig?.transcription.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE
  );
}

// Auto omits the hint so the provider detects the spoken language.
export function transcriptionLanguageParam(language: TranscriptionLanguage): {
  language?: string;
} {
  return language === "auto" ? {} : { language };
}

export const transcriptionLanguageConfigEntry: ConfigEntry = {
  key: CONFIG_KEYS.transcription.language,
  label: "Transcription language",
  description:
    "Auto detects the spoken language of each snippet. A fixed language helps accuracy when every meeting uses it.",
  notes:
    "Captured when a meeting starts. Changes apply to new meetings, and the finalized audio pass uses the same value.",
  category: "Transcription",
  group: "Advanced",
  valueType: "select",
  defaultValue: DEFAULT_TRANSCRIPTION_LANGUAGE,
  scopes: {
    global: {
      enabled: true,
      required: true,
      role: "superadmin",
      control: "select",
    },
    server: {
      enabled: true,
      required: false,
      role: "admin",
      control: "select",
    },
  },
  ui: { type: "select", options: [...TRANSCRIPTION_LANGUAGES] },
};
