import type {
  ModelParamConfig,
  ModelParamRole,
  ModelReasoningEffort,
  ModelSamplingMode,
  ModelVerbosity,
} from "./types";

export const MODEL_SAMPLING_MODES = ["reasoning", "temperature"] as const;
export const MODEL_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const MODEL_VERBOSITY_OPTIONS = [
  "default",
  "low",
  "medium",
  "high",
] as const;

export const MODEL_PARAM_ROLES: ModelParamRole[] = [
  "notes",
  "meetingSummary",
  "notesCorrection",
  "dictionaryTeaching",
  "transcriptionCleanup",
  "transcriptionCoalesce",
  "ask",
  "liveVoiceGate",
  "liveVoiceResponder",
  "imagePrompt",
  "autoRecordCancel",
];

export const MODEL_PARAM_FIELDS = [
  "samplingMode",
  "reasoningEffort",
  "temperature",
  "verbosity",
] as const;

export type ModelParamField = (typeof MODEL_PARAM_FIELDS)[number];

export const buildModelParamKey = (
  role: ModelParamRole,
  field: ModelParamField,
) => `modelParams.${role}.${field}`;

export const MODEL_PARAM_ROLE_LABELS: Record<ModelParamRole, string> = {
  notes: "Notes",
  meetingSummary: "Meeting summary",
  notesCorrection: "Notes correction",
  dictionaryTeaching: "Dictionary teaching",
  transcriptionCleanup: "Transcription cleanup",
  transcriptionCoalesce: "Transcription coalesce",
  ask: "Q&A",
  liveVoiceGate: "Live voice gate",
  liveVoiceResponder: "Live voice responder",
  imagePrompt: "Image prompt",
  autoRecordCancel: "Auto-record cancellation",
};

const defaultReasoningEffort: ModelReasoningEffort = "low";
const defaultVerbosity: ModelVerbosity = "default";

const buildDefaults = (
  samplingMode: ModelSamplingMode,
  temperature: number,
): ModelParamConfig => ({
  samplingMode,
  reasoningEffort: defaultReasoningEffort,
  temperature,
  verbosity: defaultVerbosity,
});

export const MODEL_PARAM_DEFAULTS: Record<ModelParamRole, ModelParamConfig> = {
  notes: buildDefaults("temperature", 0),
  meetingSummary: buildDefaults("temperature", 0),
  notesCorrection: buildDefaults("temperature", 0),
  dictionaryTeaching: buildDefaults("temperature", 0),
  transcriptionCleanup: buildDefaults("temperature", 0),
  transcriptionCoalesce: buildDefaults("reasoning", 0),
  ask: buildDefaults("temperature", 1),
  liveVoiceGate: buildDefaults("reasoning", 0),
  liveVoiceResponder: buildDefaults("temperature", 1),
  imagePrompt: buildDefaults("temperature", 0.5),
  autoRecordCancel: buildDefaults("reasoning", 0),
};
