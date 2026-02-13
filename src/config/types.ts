export type ConfigScope = "global" | "server" | "channel" | "user" | "meeting";
export type ConfigValueType = "boolean" | "string" | "number" | "select";
export type ConfigTier = "free" | "basic" | "pro";
export type ModelRole =
  | "notes"
  | "meetingSummary"
  | "notesCorrection"
  | "transcription"
  | "transcriptionCleanup"
  | "transcriptionCoalesce"
  | "image"
  | "imagePrompt"
  | "ask"
  | "liveVoiceGate"
  | "liveVoiceResponder"
  | "liveVoiceTts"
  | "autoRecordCancel";
export type ModelParamRole = Exclude<
  ModelRole,
  "transcription" | "image" | "liveVoiceTts"
>;
export type ModelSamplingMode = "reasoning" | "temperature";
export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ModelVerbosity = "default" | "low" | "medium" | "high";
export type ModelParamConfig = {
  samplingMode: ModelSamplingMode;
  reasoningEffort: ModelReasoningEffort;
  temperature?: number;
  verbosity?: ModelVerbosity;
};
export type ModelParamsByRole = Partial<
  Record<ModelParamRole, ModelParamConfig>
>;
export type ConfigGroup =
  | "Recommended"
  | "Standard"
  | "Experimental"
  | "Advanced";
export type ConfigScopeRole = "superadmin" | "admin" | "member";
export type ConfigScopeControl =
  | "toggle"
  | "tri-state"
  | "select"
  | "number"
  | "text";
export type ConfigScopeConfig = {
  enabled: boolean;
  required: boolean;
  role: ConfigScopeRole;
  control: ConfigScopeControl;
  notes?: string;
};
export type ConfigUiControl =
  | { type: "toggle" }
  | { type: "text"; placeholder?: string }
  | {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      minKey?: string;
      maxKey?: string;
    }
  | { type: "select"; options: string[]; placeholder?: string }
  | { type: "segmented"; options: string[] }
  | { type: "custom"; renderer: string; options?: string[] };
export type ConfigEntry = {
  key: string;
  label: string;
  description: string;
  notes?: string;
  category: string;
  group?: ConfigGroup;
  valueType: ConfigValueType;
  defaultValue?: unknown;
  experimentalValue?: unknown;
  scopes: Partial<Record<ConfigScope, ConfigScopeConfig>>;
  minTier?: ConfigTier;
  requiresExperimentalTag?: boolean;
  ui: ConfigUiControl;
};

export type ConfigOverrideValue = {
  key: string;
  value: unknown;
  scope: ConfigScope;
};

export type ResolvedConfigValue = {
  key: string;
  value: unknown;
  source: ConfigScope | "appconfig" | "default" | "experimental" | "gated";
  gated?: boolean;
};

export type ResolvedConfigSnapshot = {
  values: Record<string, ResolvedConfigValue>;
  experimentalEnabled: boolean;
  tier?: ConfigTier;
  missingRequired: string[];
};

export type MeetingRuntimeConfig = {
  transcription: {
    suppressionEnabled: boolean;
    suppressionHardSilenceDbfs: number;
    suppressionRateMaxSeconds: number;
    suppressionRateMinWords: number;
    suppressionRateMinSyllables: number;
    suppressionRateMaxSyllablesPerSecond: number;
    promptEchoEnabled: boolean;
    fastSilenceMs: number;
    slowSilenceMs: number;
    minSnippetSeconds: number;
    maxSnippetMs: number;
    fastFinalizationEnabled: boolean;
    interjectionEnabled: boolean;
    interjectionMinSpeakerSeconds: number;
    noiseGate: {
      enabled: boolean;
      windowMs: number;
      peakDbfs: number;
      minActiveWindows: number;
      minPeakAboveNoiseDb: number;
      applyToFast: boolean;
      applyToSlow: boolean;
    };
  };
  premiumTranscription: {
    enabled: boolean;
    cleanupEnabled: boolean;
  };
  dictionary: {
    maxEntries: number;
    maxCharsTranscription: number;
    maxCharsContext: number;
  };
  autoRecordCancellation: {
    enabled: boolean;
  };
  visionCaptions: {
    enabled: boolean;
    maxImages: number;
    maxTotalChars: number;
  };
  modelParams?: ModelParamsByRole;
  modelChoices?: Partial<Record<ModelRole, string>>;
};
