import { CONFIG_KEYS } from "../config/keys";
import { CONFIG_REGISTRY } from "../config/registry";
import type { ConfigTier, MeetingRuntimeConfig } from "../config/types";
import { resolveConfigSnapshot } from "./unifiedConfigService";
import { resolveDictionaryBudgets } from "../utils/dictionary";
import { resolveModelParamsByRole } from "./openaiModelParams";
import { resolveModelChoicesByRole } from "./modelChoiceService";

const requireValue = (
  snapshot: Awaited<ReturnType<typeof resolveConfigSnapshot>>,
  key: string,
) => {
  const entry = snapshot.values[key];
  if (!entry || entry.value === undefined || entry.value === null) {
    throw new Error(`Missing required config value for ${key}.`);
  }
  return entry.value;
};

export async function resolveMeetingRuntimeConfig(input: {
  guildId: string;
  channelId: string;
  userId: string;
  tier?: ConfigTier;
}): Promise<MeetingRuntimeConfig> {
  const snapshot = await resolveConfigSnapshot({
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    tier: input.tier,
  });
  const valuesByKey: Record<string, unknown> = {};
  Object.entries(snapshot.values).forEach(([key, entry]) => {
    valuesByKey[key] = entry.value;
  });
  const dictionaryBudgets = resolveDictionaryBudgets(valuesByKey, input.tier);
  const modelParams = resolveModelParamsByRole(snapshot);
  const modelChoices = resolveModelChoicesByRole(snapshot);

  return {
    transcription: {
      suppressionEnabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.transcription.suppressionEnabled),
      ),
      suppressionHardSilenceDbfs: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.suppressionHardSilenceDbfs,
        ),
      ),
      suppressionRateMaxSeconds: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.suppressionRateMaxSeconds,
        ),
      ),
      suppressionRateMinWords: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.suppressionRateMinWords,
        ),
      ),
      suppressionRateMinSyllables: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.suppressionRateMinSyllables,
        ),
      ),
      suppressionRateMaxSyllablesPerSecond: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.suppressionRateMaxSyllablesPerSecond,
        ),
      ),
      promptEchoEnabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.transcription.promptEchoEnabled),
      ),
      fastSilenceMs: Number(
        requireValue(snapshot, CONFIG_KEYS.transcription.fastSilenceMs),
      ),
      slowSilenceMs: Number(
        requireValue(snapshot, CONFIG_KEYS.transcription.slowSilenceMs),
      ),
      minSnippetSeconds: Number(
        requireValue(snapshot, CONFIG_KEYS.transcription.minSnippetSeconds),
      ),
      maxSnippetMs: Number(
        requireValue(snapshot, CONFIG_KEYS.transcription.maxSnippetMs),
      ),
      fastFinalizationEnabled: Boolean(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.fastFinalizationEnabled,
        ),
      ),
      interjectionEnabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.transcription.interjectionEnabled),
      ),
      interjectionMinSpeakerSeconds: Number(
        requireValue(
          snapshot,
          CONFIG_KEYS.transcription.interjectionMinSpeakerSeconds,
        ),
      ),
      noiseGate: {
        enabled: Boolean(
          requireValue(snapshot, CONFIG_KEYS.transcription.noiseGateEnabled),
        ),
        windowMs: Number(
          requireValue(snapshot, CONFIG_KEYS.transcription.noiseGateWindowMs),
        ),
        peakDbfs: Number(
          requireValue(snapshot, CONFIG_KEYS.transcription.noiseGatePeakDbfs),
        ),
        minActiveWindows: Number(
          requireValue(
            snapshot,
            CONFIG_KEYS.transcription.noiseGateMinActiveWindows,
          ),
        ),
        minPeakAboveNoiseDb: Number(
          requireValue(
            snapshot,
            CONFIG_KEYS.transcription.noiseGateMinPeakAboveNoiseDb,
          ),
        ),
        applyToFast: Boolean(
          requireValue(
            snapshot,
            CONFIG_KEYS.transcription.noiseGateApplyToFast,
          ),
        ),
        applyToSlow: Boolean(
          requireValue(
            snapshot,
            CONFIG_KEYS.transcription.noiseGateApplyToSlow,
          ),
        ),
      },
    },
    premiumTranscription: {
      enabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.transcription.premiumEnabled),
      ),
      cleanupEnabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.transcription.premiumCleanupEnabled),
      ),
    },
    dictionary: dictionaryBudgets,
    autoRecordCancellation: {
      enabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.autorecord.cancelEnabled),
      ),
    },
    visionCaptions: {
      enabled: Boolean(
        requireValue(snapshot, CONFIG_KEYS.visionCaptions.enabled),
      ),
      maxImages: Number(
        requireValue(snapshot, CONFIG_KEYS.visionCaptions.maxImages),
      ),
      maxTotalChars: Number(
        requireValue(snapshot, CONFIG_KEYS.visionCaptions.maxTotalChars),
      ),
    },
    modelParams,
    modelChoices,
  };
}

export function getConfigRegistry() {
  return CONFIG_REGISTRY;
}
