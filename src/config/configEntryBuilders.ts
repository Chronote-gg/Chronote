import type { ConfigEntry, ConfigScopeConfig } from "./types";
import {
  MODEL_PARAM_DEFAULTS,
  MODEL_PARAM_ROLE_LABELS,
  MODEL_PARAM_ROLES,
  MODEL_REASONING_EFFORTS,
  MODEL_SAMPLING_MODES,
  MODEL_VERBOSITY_OPTIONS,
  buildModelParamKey,
} from "./modelParams";
import {
  MODEL_SELECTION_DEFAULTS,
  MODEL_SELECTION_OPTIONS,
  MODEL_SELECTION_ROLE_LABELS,
  MODEL_SELECTION_ROLES,
  buildModelSelectionKey,
} from "./modelChoices";

export const scope = (
  enabled: boolean,
  required: boolean,
  role: ConfigScopeConfig["role"],
  control: ConfigScopeConfig["control"],
  notes?: string,
): ConfigScopeConfig => ({
  enabled,
  required,
  role,
  control,
  ...(notes ? { notes } : {}),
});

export const buildModelParamEntries = (): ConfigEntry[] =>
  MODEL_PARAM_ROLES.flatMap((role) => {
    const labelBase = MODEL_PARAM_ROLE_LABELS[role];
    const defaults = MODEL_PARAM_DEFAULTS[role];
    const category = "Model tuning";
    const group: ConfigEntry["group"] = "Advanced";
    return [
      {
        key: buildModelParamKey(role, "samplingMode"),
        label: `${labelBase} sampling mode`,
        description: "Choose whether this role uses reasoning or temperature.",
        category,
        group,
        valueType: "select",
        defaultValue: defaults.samplingMode,
        scopes: {
          global: scope(true, true, "superadmin", "select"),
          server: scope(true, false, "admin", "select"),
        },
        ui: { type: "segmented", options: [...MODEL_SAMPLING_MODES] },
      },
      {
        key: buildModelParamKey(role, "reasoningEffort"),
        label: `${labelBase} reasoning effort`,
        description: "Reasoning effort used when sampling mode is reasoning.",
        category,
        group,
        valueType: "select",
        defaultValue: defaults.reasoningEffort,
        scopes: {
          global: scope(true, true, "superadmin", "select"),
          server: scope(true, false, "admin", "select"),
        },
        ui: { type: "select", options: [...MODEL_REASONING_EFFORTS] },
      },
      {
        key: buildModelParamKey(role, "temperature"),
        label: `${labelBase} temperature`,
        description: "Temperature used when sampling mode is temperature.",
        category,
        group,
        valueType: "number",
        defaultValue: defaults.temperature,
        scopes: {
          global: scope(true, true, "superadmin", "number"),
          server: scope(true, false, "admin", "number"),
        },
        ui: { type: "number", min: 0, max: 2, step: 0.1 },
      },
      {
        key: buildModelParamKey(role, "verbosity"),
        label: `${labelBase} verbosity`,
        description: "Verbosity hint for models that support it.",
        category,
        group,
        valueType: "select",
        defaultValue: defaults.verbosity,
        scopes: {
          global: scope(true, true, "superadmin", "select"),
          server: scope(true, false, "admin", "select"),
        },
        ui: { type: "select", options: [...MODEL_VERBOSITY_OPTIONS] },
      },
    ];
  });

export const buildModelSelectionEntries = (): ConfigEntry[] =>
  MODEL_SELECTION_ROLES.map((role) => {
    const labelBase = MODEL_SELECTION_ROLE_LABELS[role];
    const category = "Models";
    const group: ConfigEntry["group"] = "Advanced";
    return {
      key: buildModelSelectionKey(role),
      label: `${labelBase} model`,
      description: `Model used for ${labelBase.toLowerCase()}.`,
      category,
      group,
      valueType: "select",
      defaultValue: MODEL_SELECTION_DEFAULTS[role],
      scopes: {
        global: scope(true, true, "superadmin", "select"),
        server: scope(true, false, "admin", "select"),
      },
      ui: { type: "select", options: MODEL_SELECTION_OPTIONS[role] },
    };
  });
