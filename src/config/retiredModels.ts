// Stored, frozen or environment choices of a retired model run on the role's
// current default instead of failing.
export const RETIRED_CHAT_MODELS = ["gpt-4o-mini"];
// Unprompted these hallucinate on non-speech (ADR-20261116).
export const RETIRED_TRANSCRIPTION_MODELS = [
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
];
