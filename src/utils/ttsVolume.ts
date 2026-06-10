export const DEFAULT_TTS_VOLUME_PERCENT = 100;
export const MIN_TTS_VOLUME_PERCENT = 0;
export const MAX_TTS_VOLUME_PERCENT = 200;

export function normalizeTtsVolumePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_TTS_VOLUME_PERCENT || rounded > MAX_TTS_VOLUME_PERCENT) {
    return undefined;
  }
  return rounded;
}

export function resolveTtsVolumePercent(value: unknown): number {
  return normalizeTtsVolumePercent(value) ?? DEFAULT_TTS_VOLUME_PERCENT;
}

export function ttsVolumePercentToMultiplier(value: unknown): number {
  return resolveTtsVolumePercent(value) / DEFAULT_TTS_VOLUME_PERCENT;
}
