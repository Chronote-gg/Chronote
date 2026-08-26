import type {
  ModelParamConfig,
  ModelParamRole,
  ModelParamsByRole,
  ModelReasoningEffort,
  ModelVerbosity,
  ResolvedConfigSnapshot,
} from "../config/types";
import {
  MODEL_PARAM_DEFAULTS,
  MODEL_PARAM_ROLES,
  MODEL_REASONING_EFFORTS,
  MODEL_SAMPLING_MODES,
  MODEL_VERBOSITY_OPTIONS,
  buildModelParamKey,
} from "../config/modelParams";
import {
  getSnapshotValue,
  resolveConfigSnapshot,
  resolveEnumValue,
  type ConfigResolveContext,
} from "./unifiedConfigService";

type OpenAIChatParams = {
  temperature?: number;
  reasoning_effort?: ModelReasoningEffort;
  verbosity?: Exclude<ModelVerbosity, "default">;
};

type ModelCapabilities = {
  supportsReasoning: boolean;
  supportsTemperature: boolean;
  supportsVerbosity: boolean;
  temperatureRequiresReasoningNone: boolean;
  supportedReasoningEfforts: ModelReasoningEffort[];
};

const REASONING_ORDER: ModelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const clampTemperature = (value?: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(2, Math.max(0, value));
};

const pickReasoningEffort = (
  requested: ModelReasoningEffort,
  supported: ModelReasoningEffort[],
) => {
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;
  const targetIndex = REASONING_ORDER.indexOf(requested);
  if (targetIndex < 0) return supported[0];
  for (let i = targetIndex; i >= 0; i -= 1) {
    const candidate = REASONING_ORDER[i];
    if (supported.includes(candidate)) return candidate;
  }
  for (let i = targetIndex + 1; i < REASONING_ORDER.length; i += 1) {
    const candidate = REASONING_ORDER[i];
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0];
};

const requiresReasoningNoneForTemperature = (capabilities: ModelCapabilities) =>
  capabilities.temperatureRequiresReasoningNone &&
  capabilities.supportedReasoningEfforts.includes("none");

const applyTemperatureMode = (params: {
  output: OpenAIChatParams;
  capabilities: ModelCapabilities;
  temperature?: number;
  reasoningEffort?: ModelReasoningEffort;
}) => {
  const { output, capabilities, temperature, reasoningEffort } = params;
  if (capabilities.supportsTemperature && temperature !== undefined) {
    if (requiresReasoningNoneForTemperature(capabilities)) {
      output.reasoning_effort = "none";
    }
    output.temperature = temperature;
    return;
  }
  if (capabilities.supportsReasoning && reasoningEffort) {
    output.reasoning_effort = reasoningEffort;
  }
};

const applyReasoningMode = (params: {
  output: OpenAIChatParams;
  capabilities: ModelCapabilities;
  temperature?: number;
  reasoningEffort?: ModelReasoningEffort;
}) => {
  const { output, capabilities, temperature, reasoningEffort } = params;
  if (capabilities.supportsReasoning && reasoningEffort) {
    output.reasoning_effort = reasoningEffort;
    return;
  }
  if (capabilities.supportsTemperature && temperature !== undefined) {
    if (requiresReasoningNoneForTemperature(capabilities)) {
      output.reasoning_effort = "none";
    }
    output.temperature = temperature;
  }
};

const resolveModelCapabilities = (model: string): ModelCapabilities => {
  const normalized = model.trim().toLowerCase();
  const base: ModelCapabilities = {
    supportsReasoning: false,
    supportsTemperature: true,
    supportsVerbosity: false,
    temperatureRequiresReasoningNone: false,
    supportedReasoningEfforts: [],
  };

  if (
    normalized === "gpt-5.6" ||
    normalized.startsWith("gpt-5.6-sol") ||
    normalized.startsWith("gpt-5.6-terra") ||
    normalized.startsWith("gpt-5.6-luna")
  ) {
    return {
      supportsReasoning: true,
      supportsTemperature: true,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: true,
      supportedReasoningEfforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    };
  }

  if (normalized.startsWith("gpt-5.2-pro")) {
    return {
      supportsReasoning: true,
      supportsTemperature: false,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: false,
      supportedReasoningEfforts: ["medium", "high", "xhigh"],
    };
  }
  if (normalized.startsWith("gpt-5.2")) {
    return {
      supportsReasoning: true,
      supportsTemperature: true,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    };
  }
  if (normalized.startsWith("gpt-5.1-codex-max")) {
    return {
      supportsReasoning: true,
      supportsTemperature: true,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: true,
      supportedReasoningEfforts: ["none", "medium", "high", "xhigh"],
    };
  }
  if (normalized.startsWith("gpt-5.1")) {
    return {
      supportsReasoning: true,
      supportsTemperature: true,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
    };
  }
  if (normalized.startsWith("gpt-5-pro")) {
    return {
      supportsReasoning: true,
      supportsTemperature: false,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: false,
      supportedReasoningEfforts: ["high"],
    };
  }
  if (normalized.startsWith("gpt-5")) {
    return {
      supportsReasoning: true,
      supportsTemperature: false,
      supportsVerbosity: true,
      temperatureRequiresReasoningNone: false,
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    };
  }

  return base;
};

const resolveConfigSamplingMode = (
  snapshot: ResolvedConfigSnapshot,
  role: ModelParamRole,
) =>
  resolveEnumValue(
    getSnapshotValue(snapshot, buildModelParamKey(role, "samplingMode")),
    MODEL_SAMPLING_MODES,
    MODEL_PARAM_DEFAULTS[role].samplingMode,
  ) ?? MODEL_PARAM_DEFAULTS[role].samplingMode;

const resolveConfigReasoningEffort = (
  snapshot: ResolvedConfigSnapshot,
  role: ModelParamRole,
) =>
  resolveEnumValue(
    getSnapshotValue(snapshot, buildModelParamKey(role, "reasoningEffort")),
    MODEL_REASONING_EFFORTS,
    MODEL_PARAM_DEFAULTS[role].reasoningEffort,
  ) ?? MODEL_PARAM_DEFAULTS[role].reasoningEffort;

const resolveConfigVerbosity = (
  snapshot: ResolvedConfigSnapshot,
  role: ModelParamRole,
) =>
  resolveEnumValue(
    getSnapshotValue(snapshot, buildModelParamKey(role, "verbosity")),
    MODEL_VERBOSITY_OPTIONS,
    MODEL_PARAM_DEFAULTS[role].verbosity,
  ) ?? MODEL_PARAM_DEFAULTS[role].verbosity;

const resolveConfigTemperature = (
  snapshot: ResolvedConfigSnapshot,
  role: ModelParamRole,
) => {
  const rawValue = getSnapshotValue(
    snapshot,
    buildModelParamKey(role, "temperature"),
  );
  const parsed = Number(rawValue);
  const resolved = Number.isFinite(parsed)
    ? parsed
    : MODEL_PARAM_DEFAULTS[role].temperature;
  return clampTemperature(resolved) ?? MODEL_PARAM_DEFAULTS[role].temperature;
};

export const resolveModelParamsByRole = (
  snapshot: ResolvedConfigSnapshot,
): ModelParamsByRole => {
  const resolved: ModelParamsByRole = {};
  MODEL_PARAM_ROLES.forEach((role) => {
    resolved[role] = {
      samplingMode: resolveConfigSamplingMode(snapshot, role),
      reasoningEffort: resolveConfigReasoningEffort(snapshot, role),
      temperature: resolveConfigTemperature(snapshot, role),
      verbosity: resolveConfigVerbosity(snapshot, role),
    };
  });
  return resolved;
};

export const resolveModelParamsForContext = async (
  context: ConfigResolveContext,
): Promise<ModelParamsByRole> => {
  const snapshot = await resolveConfigSnapshot(context);
  return resolveModelParamsByRole(snapshot);
};

export const resolveChatParamsForRole = (options: {
  role: ModelParamRole;
  model: string;
  config?: ModelParamConfig;
}): OpenAIChatParams => {
  const config = options.config ?? MODEL_PARAM_DEFAULTS[options.role];
  const capabilities = resolveModelCapabilities(options.model);
  const temperature = clampTemperature(config.temperature);
  const reasoningEffort = pickReasoningEffort(
    config.reasoningEffort,
    capabilities.supportedReasoningEfforts,
  );

  const output: OpenAIChatParams = {};
  const samplingMode = config.samplingMode;

  if (samplingMode === "temperature") {
    applyTemperatureMode({
      output,
      capabilities,
      temperature,
      reasoningEffort,
    });
  } else if (samplingMode === "reasoning") {
    applyReasoningMode({
      output,
      capabilities,
      temperature,
      reasoningEffort,
    });
  }

  const verbosity = config.verbosity;
  if (capabilities.supportsVerbosity && verbosity && verbosity !== "default") {
    output.verbosity = verbosity;
  }

  return output;
};
