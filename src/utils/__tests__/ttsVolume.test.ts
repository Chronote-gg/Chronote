import {
  DEFAULT_TTS_VOLUME_PERCENT,
  MAX_TTS_VOLUME_PERCENT,
  MIN_TTS_VOLUME_PERCENT,
  normalizeTtsVolumePercent,
  resolveTtsVolumePercent,
  ttsVolumePercentToMultiplier,
} from "../ttsVolume";

describe("ttsVolume utils", () => {
  it("accepts rounded values inside the allowed percentage range", () => {
    expect(normalizeTtsVolumePercent(MIN_TTS_VOLUME_PERCENT)).toBe(0);
    expect(normalizeTtsVolumePercent(75.4)).toBe(75);
    expect(normalizeTtsVolumePercent(75.5)).toBe(76);
    expect(normalizeTtsVolumePercent(DEFAULT_TTS_VOLUME_PERCENT)).toBe(100);
    expect(normalizeTtsVolumePercent(MAX_TTS_VOLUME_PERCENT)).toBe(200);
  });

  it("rejects values outside the allowed percentage range", () => {
    expect(normalizeTtsVolumePercent(-1)).toBeUndefined();
    expect(normalizeTtsVolumePercent(201)).toBeUndefined();
    expect(normalizeTtsVolumePercent(Number.NaN)).toBeUndefined();
    expect(normalizeTtsVolumePercent("100")).toBeUndefined();
  });

  it("resolves default volume and converts to ffmpeg multiplier", () => {
    expect(resolveTtsVolumePercent(undefined)).toBe(DEFAULT_TTS_VOLUME_PERCENT);
    expect(ttsVolumePercentToMultiplier(undefined)).toBe(1);
    expect(ttsVolumePercentToMultiplier(50)).toBe(0.5);
    expect(ttsVolumePercentToMultiplier(150)).toBe(1.5);
  });
});
