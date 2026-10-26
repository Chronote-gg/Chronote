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
