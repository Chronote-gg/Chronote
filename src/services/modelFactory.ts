import { config } from "./configService";
import type { ModelRole } from "../config/types";

export type ModelProvider = "openai";

export type ModelChoice = {
  provider: ModelProvider;
  model: string;
};

export type ModelOverrides = Partial<Record<ModelRole, ModelChoice>>;

export const buildModelOverrides = (
  choices?: Partial<Record<ModelRole, string>>,
): ModelOverrides | undefined => {
  if (!choices) return undefined;
  const overrides: ModelOverrides = {};
  (Object.entries(choices) as [ModelRole, string][]).forEach(
    ([role, model]) => {
      const trimmed = model?.trim();
      if (!trimmed) return;
      overrides[role] = { provider: "openai", model: trimmed };
    },
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
};

const defaultModels: Record<ModelRole, ModelChoice> = {
  notes: { provider: "openai", model: config.notes.model },
  meetingSummary: { provider: "openai", model: config.notes.model },
  notesCorrection: { provider: "openai", model: config.notes.model },
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  transcriptionCleanup: { provider: "openai", model: config.notes.model },
  transcriptionCoalesce: { provider: "openai", model: "gpt-5-mini" },
  imageCaption: { provider: "openai", model: "gpt-4o-mini" },
  image: { provider: "openai", model: "dall-e-3" },
  imagePrompt: { provider: "openai", model: config.notes.model },
  ask: { provider: "openai", model: config.liveVoice.responderModel },
  liveVoiceGate: { provider: "openai", model: config.liveVoice.gateModel },
  liveVoiceResponder: {
    provider: "openai",
    model: config.liveVoice.responderModel,
  },
  liveVoiceTts: { provider: "openai", model: config.liveVoice.ttsModel },
  autoRecordCancel: { provider: "openai", model: config.liveVoice.gateModel },
};

export function getModelChoice(
  role: ModelRole,
  overrides?: ModelOverrides,
): ModelChoice {
  return overrides?.[role] ?? defaultModels[role];
}
