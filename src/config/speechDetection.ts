import type { ConfigEntry } from "./types";
import { CONFIG_KEYS } from "./keys";
import { z } from "zod";

export const SPEECH_DETECTION_MODES = ["off", "shadow", "enforce"] as const;
export const speechDetectionModeSchema = z.enum(SPEECH_DETECTION_MODES);
export type SpeechDetectionMode = z.infer<typeof speechDetectionModeSchema>;
export const DEFAULT_SPEECH_DETECTION_MODE: SpeechDetectionMode = "off";

export function resolveSpeechDetectionMode(
  value: unknown,
): SpeechDetectionMode {
  return speechDetectionModeSchema.parse(value);
}

export const speechDetectionConfigEntry: ConfigEntry = {
  key: CONFIG_KEYS.transcription.speechDetectionMode,
  label: "Speech detection mode",
  description:
    "Off preserves transcription. Shadow measures speech detection without skipping requests. Enforce may skip verified nonspeech.",
  notes:
    "Captured when a meeting starts. Global changes apply to new meetings.",
  category: "Transcription",
  group: "Experimental",
  valueType: "select",
  defaultValue: DEFAULT_SPEECH_DETECTION_MODE,
  scopes: {
    global: {
      enabled: true,
      required: true,
      role: "superadmin",
      control: "select",
    },
  },
  ui: { type: "select", options: [...SPEECH_DETECTION_MODES] },
};
