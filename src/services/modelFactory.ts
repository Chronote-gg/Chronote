import {
  MODEL_SELECTION_DEFAULTS,
  isRetiredModel,
} from "../config/modelChoices";
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

const warnedRetired = new Set<string>();

// A meeting's saved choice of a retired model runs on the role's default.
export function getModelChoice(
  role: ModelRole,
  overrides?: ModelOverrides,
): ModelChoice {
  const override = overrides?.[role];
  if (override && !isRetiredModel(role, override.model)) return override;
  const model = MODEL_SELECTION_DEFAULTS[role];
  if (override && !warnedRetired.has(`${role}:${override.model}`)) {
    warnedRetired.add(`${role}:${override.model}`);
    console.warn("Saved model choice is retired; using the default.", {
      role,
      retiredModel: override.model,
      model,
    });
  }
  return { provider: "openai", model };
}
