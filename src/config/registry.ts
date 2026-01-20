import type { ConfigEntry, ConfigScopeConfig } from "./types";
import {
  FAST_SILENCE_THRESHOLD,
  MAX_SNIPPET_LENGTH,
  MINIMUM_TRANSCRIPTION_LENGTH,
  NOISE_GATE_APPLY_TO_FAST,
  NOISE_GATE_APPLY_TO_SLOW,
  NOISE_GATE_ENABLED,
  NOISE_GATE_MIN_ACTIVE_WINDOWS,
  NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  NOISE_GATE_PEAK_DBFS,
  NOISE_GATE_WINDOW_MS,
  SILENCE_THRESHOLD,
} from "../constants";
import { DEFAULT_TTS_VOICE, TTS_VOICES } from "../utils/ttsVoices";
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

const scope = (
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

const buildModelParamEntries = (): ConfigEntry[] =>
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
        description: "Verbosity hint for GPT-5 models.",
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

const buildModelSelectionEntries = (): ConfigEntry[] =>
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

export const CONFIG_REGISTRY: ConfigEntry[] = [
  {
    key: "features.experimental",
    label: "Experimental features",
    description:
      "Allow experimental features for this server, gated by tier where needed.",
    category: "Experimental",
    group: "Experimental",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.premium.enabled",
    label: "Premium transcription",
    description: "Enable premium transcription for this server.",
    notes:
      "Product note: marketed as pro, currently enabled for all tiers to improve default transcription quality.",
    category: "Transcription",
    group: "Experimental",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.premium.cleanup.enabled",
    label: "Premium cleanup pass",
    description:
      "Run the transcription cleanup pass for premium transcription.",
    notes:
      "Product note: marketed as pro, currently enabled for all tiers to improve default transcription quality.",
    category: "Transcription",
    group: "Experimental",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.suppression.enabled",
    label: "Transcription suppression",
    description:
      "Enable guardrails that suppress low-confidence text from quiet audio.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: true,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.fastSilenceMs",
    label: "Fast silence threshold (ms)",
    description: "Silence duration before running the fast transcription pass.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: FAST_SILENCE_THRESHOLD,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 100, max: 5000, step: 50 },
  },
  {
    key: "transcription.slowSilenceMs",
    label: "Slow silence threshold (ms)",
    description: "Silence duration before finalizing a transcription snippet.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: SILENCE_THRESHOLD,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 500, max: 10000, step: 100 },
  },
  {
    key: "transcription.minSnippetSeconds",
    label: "Minimum snippet seconds",
    description: "Minimum audio length required before transcribing a snippet.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: MINIMUM_TRANSCRIPTION_LENGTH,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 0.1, max: 5, step: 0.1 },
  },
  {
    key: "transcription.maxSnippetMs",
    label: "Maximum snippet duration (ms)",
    description:
      "Maximum duration for a single snippet before starting a new one.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: MAX_SNIPPET_LENGTH,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 5000, max: 180000, step: 1000 },
  },
  {
    key: "transcription.fastFinalization.enabled",
    label: "Fast-only finalization",
    description:
      "Skip the slow transcription pass when the latest fast transcript covers the full snippet.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.interjection.enabled",
    label: "Interjection-aware splitting",
    description:
      "Finalize paused snippets when another speaker interjects to improve ordering.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.interjection.minSpeakerSeconds",
    label: "Interjection minimum speaker seconds",
    description:
      "Minimum audio seconds for an interjection before we split paused snippets.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: MINIMUM_TRANSCRIPTION_LENGTH,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    ui: { type: "number", min: 0.1, max: 5, step: 0.1 },
  },
  {
    key: "transcription.noiseGate.enabled",
    label: "Transcription noise gate",
    description:
      "Skip transcription for snippets that are very quiet and lack speech-like peaks.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: NOISE_GATE_ENABLED,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.noiseGate.windowMs",
    label: "Noise gate window (ms)",
    description: "Window size used for peak analysis.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: NOISE_GATE_WINDOW_MS,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 5, max: 200, step: 5 },
  },
  {
    key: "transcription.noiseGate.peakDbfs",
    label: "Noise gate peak threshold (dBFS)",
    description:
      "Skip when overall peak stays below this level and there are not enough active windows.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: NOISE_GATE_PEAK_DBFS,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: -90, max: -5, step: 1 },
  },
  {
    key: "transcription.noiseGate.minActiveWindows",
    label: "Noise gate minimum active windows",
    description:
      "Minimum number of windows that must exceed the noise floor plus the offset.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: NOISE_GATE_MIN_ACTIVE_WINDOWS,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 0, max: 50, step: 1 },
  },
  {
    key: "transcription.noiseGate.minPeakAboveNoiseDb",
    label: "Noise gate noise floor offset (dB)",
    description:
      "Minimum dB above the noise floor for a window to count as active.",
    category: "Transcription",
    group: "Advanced",
    valueType: "number",
    defaultValue: NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(false, false, "admin", "number"),
    },
    ui: { type: "number", min: 0, max: 60, step: 1 },
  },
  {
    key: "transcription.noiseGate.applyToFast",
    label: "Noise gate on fast pass",
    description: "Apply noise gate before fast transcription.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: NOISE_GATE_APPLY_TO_FAST,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "transcription.noiseGate.applyToSlow",
    label: "Noise gate on slow pass",
    description: "Apply noise gate before slow transcription.",
    category: "Transcription",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: NOISE_GATE_APPLY_TO_SLOW,
    scopes: {
      global: scope(true, true, "superadmin", "toggle"),
      server: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "context.instructions",
    label: "Context instructions",
    description: "Context instructions applied to meetings.",
    category: "Context",
    group: "Recommended",
    valueType: "string",
    scopes: {
      server: scope(true, false, "admin", "text"),
      channel: scope(true, false, "admin", "text"),
      meeting: scope(true, false, "admin", "text"),
    },
    ui: {
      type: "text",
      placeholder: "What should Chronote know about this context?",
    },
  },
  {
    key: "dictionary.maxEntries",
    label: "Dictionary max entries",
    description:
      "Maximum dictionary entries used in prompts. Uses most recently updated terms. Set to 0 to disable dictionary usage, clamped by the global dictionary cap to protect prompt size.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 200,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    ui: {
      type: "number",
      min: 0,
      step: 1,
      maxKey: "dictionary.maxEntries.cap",
    },
  },
  {
    key: "dictionary.maxEntries.pro",
    label: "Dictionary max entries (pro)",
    description:
      "Pro tier maximum dictionary entries used in prompts. Set to 0 to disable dictionary usage for pro tier, clamped by the global dictionary cap.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 400,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    minTier: "pro",
    ui: {
      type: "number",
      min: 0,
      step: 1,
      maxKey: "dictionary.maxEntries.cap",
    },
  },
  {
    key: "dictionary.maxEntries.cap",
    label: "Dictionary max entries cap",
    description:
      "Global hard cap for dictionary entries used in prompts to protect prompt size and model quality.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 500,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
    },
    ui: { type: "number", min: 0, step: 1 },
  },
  {
    key: "dictionary.maxChars.transcription",
    label: "Dictionary transcription chars",
    description:
      "Character budget for dictionary terms in the transcription prompt. Definitions are not included. Set to 0 to disable dictionary terms in transcription, clamped by the global transcription cap.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 2000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    ui: {
      type: "number",
      min: 0,
      step: 100,
      maxKey: "dictionary.maxChars.transcription.cap",
    },
  },
  {
    key: "dictionary.maxChars.transcription.pro",
    label: "Dictionary transcription chars (pro)",
    description:
      "Pro tier character budget for dictionary terms in the transcription prompt. Definitions are not included, clamped by the global transcription cap.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 4000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    minTier: "pro",
    ui: {
      type: "number",
      min: 0,
      step: 100,
      maxKey: "dictionary.maxChars.transcription.cap",
    },
  },
  {
    key: "dictionary.maxChars.transcription.cap",
    label: "Dictionary transcription chars cap",
    description:
      "Global hard cap for dictionary transcription characters to keep prompts within a safe context window.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 6000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
    },
    ui: { type: "number", min: 0, step: 100 },
  },
  {
    key: "dictionary.maxChars.context",
    label: "Dictionary context chars",
    description:
      "Character budget for dictionary terms and definitions in cleanup, coalesce, and notes prompts. Set to 0 to disable dictionary context, clamped by the global context cap.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 6000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    ui: {
      type: "number",
      min: 0,
      step: 100,
      maxKey: "dictionary.maxChars.context.cap",
    },
  },
  {
    key: "dictionary.maxChars.context.pro",
    label: "Dictionary context chars (pro)",
    description:
      "Pro tier character budget for dictionary terms and definitions in cleanup, coalesce, and notes prompts, clamped by the global context cap.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 12000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
      server: scope(true, false, "admin", "number"),
    },
    minTier: "pro",
    ui: {
      type: "number",
      min: 0,
      step: 100,
      maxKey: "dictionary.maxChars.context.cap",
    },
  },
  {
    key: "dictionary.maxChars.context.cap",
    label: "Dictionary context chars cap",
    description:
      "Global hard cap for dictionary context characters to keep prompts within a safe context window.",
    category: "Dictionary",
    group: "Advanced",
    valueType: "number",
    defaultValue: 20000,
    scopes: {
      global: scope(true, true, "superadmin", "number"),
    },
    ui: { type: "number", min: 0, step: 100 },
  },
  {
    key: "notes.channelId",
    label: "Notes channel",
    description: "Default notes channel for meetings and auto-recording.",
    category: "Notes",
    group: "Recommended",
    valueType: "string",
    scopes: {
      server: scope(true, false, "admin", "text"),
      channel: scope(true, false, "admin", "text"),
    },
    ui: { type: "custom", renderer: "NotesChannelSelect" },
  },
  {
    key: "notes.tags",
    label: "Default tags",
    description: "Comma separated tags applied to meetings by default.",
    category: "Notes",
    group: "Recommended",
    valueType: "string",
    scopes: {
      server: scope(true, false, "admin", "text"),
      channel: scope(true, false, "admin", "text"),
    },
    ui: { type: "text", placeholder: "project x, roadmap, weekly" },
  },
  {
    key: "autorecord.enabled",
    label: "Auto-record",
    description: "Automatically record meetings by default.",
    category: "Auto-record",
    group: "Recommended",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
      channel: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "autorecord.cancel.enabled",
    label: "Auto-record cancellation",
    description: "Cancel short auto-recorded meetings with little content.",
    category: "Auto-record",
    group: "Advanced",
    valueType: "boolean",
    defaultValue: true,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "liveVoice.enabled",
    label: "Live voice responder",
    description: "Enable the live voice responder.",
    category: "Live voice",
    group: "Standard",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
      channel: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "liveVoice.commands.enabled",
    label: "Live voice commands",
    description: "Enable live voice commands.",
    category: "Live voice",
    group: "Standard",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
      channel: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "liveVoice.ttsVoice",
    label: "Live voice TTS voice",
    description: "Voice used for live voice responses.",
    category: "Live voice",
    group: "Standard",
    valueType: "select",
    defaultValue: DEFAULT_TTS_VOICE,
    scopes: {
      global: scope(true, true, "superadmin", "select"),
      server: scope(true, false, "admin", "select"),
    },
    ui: {
      type: "custom",
      renderer: "TtsVoiceSelect",
      options: [...TTS_VOICES],
    },
  },
  {
    key: "chatTts.enabled",
    label: "Chat-to-speech",
    description: "Enable chat-to-speech for the server.",
    category: "Chat TTS",
    group: "Standard",
    valueType: "boolean",
    defaultValue: false,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
      channel: scope(true, false, "admin", "tri-state"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "chatTts.voice",
    label: "Chat TTS voice",
    description: "Voice used for chat-to-speech.",
    category: "Chat TTS",
    group: "Standard",
    valueType: "select",
    defaultValue: DEFAULT_TTS_VOICE,
    scopes: {
      global: scope(true, true, "superadmin", "select"),
      server: scope(true, false, "admin", "select"),
    },
    ui: {
      type: "custom",
      renderer: "TtsVoiceSelect",
      options: [...TTS_VOICES],
    },
  },
  {
    key: "ask.members.enabled",
    label: "Ask members",
    description: "Allow Ask to use member data for responses.",
    category: "Ask",
    group: "Standard",
    valueType: "boolean",
    defaultValue: true,
    scopes: {
      server: scope(true, true, "admin", "toggle"),
    },
    ui: { type: "toggle" },
  },
  {
    key: "ask.sharing.policy",
    label: "Ask sharing policy",
    description: "Default sharing policy for Ask conversations.",
    category: "Ask",
    group: "Standard",
    valueType: "select",
    defaultValue: "server",
    scopes: {
      global: scope(true, true, "superadmin", "select"),
      server: scope(true, false, "admin", "select"),
    },
    ui: { type: "segmented", options: ["off", "server", "public"] },
  },
  ...buildModelSelectionEntries(),
  ...buildModelParamEntries(),
];

export const CONFIG_KEY_SET = new Set(
  CONFIG_REGISTRY.map((entry) => entry.key),
);

export function getConfigEntry(key: string) {
  return CONFIG_REGISTRY.find((entry) => entry.key === key);
}
