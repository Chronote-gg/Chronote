import { MODEL_SELECTION_DEFAULTS } from "../config/modelChoices";
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

export function getModelChoice(
  role: ModelRole,
  overrides?: ModelOverrides,
): ModelChoice {
  return (
    overrides?.[role] ?? {
      provider: "openai",
      model: MODEL_SELECTION_DEFAULTS[role],
    }
  );
}
