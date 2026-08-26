import type { ModelRole } from "./types";
import { config } from "../services/configService";

export const MODEL_SELECTION_ROLES: ModelRole[] = [
  "notes",
  "meetingSummary",
  "notesCorrection",
  "dictionaryTeaching",
  "transcription",
  "transcriptionCleanup",
  "transcriptionCoalesce",
  "image",
  "imagePrompt",
  "ask",
  "liveVoiceGate",
  "liveVoiceResponder",
  "liveVoiceTts",
  "autoRecordCancel",
];

export const MODEL_SELECTION_ROLE_LABELS: Record<ModelRole, string> = {
  notes: "Notes",
  meetingSummary: "Meeting summary",
  notesCorrection: "Notes correction",
  dictionaryTeaching: "Dictionary teaching",
  transcription: "Transcription",
  transcriptionCleanup: "Transcription cleanup",
  transcriptionCoalesce: "Transcription coalesce",
  image: "Image generation",
  imagePrompt: "Image prompt",
  ask: "Q&A",
  liveVoiceGate: "Live voice gate",
  liveVoiceResponder: "Live voice responder",
  liveVoiceTts: "Live voice TTS",
  autoRecordCancel: "Auto-record cancellation",
};

const CHAT_MODEL_OPTIONS = [
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o-mini",
];

const COALESCE_MODEL_OPTIONS = [
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-5.2",
  "gpt-5.2-pro",
];

const TRANSCRIPTION_MODEL_OPTIONS = ["gpt-4o-transcribe"];
const IMAGE_MODEL_OPTIONS = ["dall-e-3"];
const TTS_MODEL_OPTIONS = ["gpt-4o-mini-tts"];

export const MODEL_SELECTION_OPTIONS: Record<ModelRole, string[]> = {
  notes: CHAT_MODEL_OPTIONS,
  meetingSummary: CHAT_MODEL_OPTIONS,
  notesCorrection: CHAT_MODEL_OPTIONS,
  dictionaryTeaching: CHAT_MODEL_OPTIONS,
  transcription: TRANSCRIPTION_MODEL_OPTIONS,
  transcriptionCleanup: CHAT_MODEL_OPTIONS,
  transcriptionCoalesce: COALESCE_MODEL_OPTIONS,
  image: IMAGE_MODEL_OPTIONS,
  imagePrompt: CHAT_MODEL_OPTIONS,
  ask: CHAT_MODEL_OPTIONS,
  liveVoiceGate: CHAT_MODEL_OPTIONS,
  liveVoiceResponder: CHAT_MODEL_OPTIONS,
  liveVoiceTts: TTS_MODEL_OPTIONS,
  autoRecordCancel: CHAT_MODEL_OPTIONS,
};

export const MODEL_SELECTION_DEFAULTS: Record<ModelRole, string> = {
  notes: config.notes.model,
  meetingSummary: config.notes.model,
  notesCorrection: config.notes.model,
  dictionaryTeaching: "gpt-5-mini",
  transcription: "gpt-4o-transcribe",
  transcriptionCleanup: config.notes.model,
  transcriptionCoalesce: "gpt-5-mini",
  image: "dall-e-3",
  imagePrompt: config.notes.model,
  ask: config.liveVoice.responderModel,
  liveVoiceGate: config.liveVoice.gateModel,
  liveVoiceResponder: config.liveVoice.responderModel,
  liveVoiceTts: config.liveVoice.ttsModel,
  autoRecordCancel: config.liveVoice.gateModel,
};

export const buildModelSelectionKey = (role: ModelRole) => `models.${role}`;
