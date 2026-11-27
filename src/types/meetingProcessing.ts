export type TranscriptionOutcome = "ready" | "empty" | "partial" | "failed";

export type GenerationOutcome = "generated" | "skipped" | "failed";

export type MeetingProcessingOutcome = {
  transcription?: TranscriptionOutcome;
  notes?: GenerationOutcome;
  summary?: GenerationOutcome;
};

export type TranscriptionFacts = {
  usableSegments: number;
  failedSegments: number;
  /** Live snippets the transcription queue refused; only Discord capture has them. */
  queueRejectedSegments?: number;
  captureIncomplete: boolean;
};

export type ProcessingNotice = {
  tone: "neutral" | "warning" | "error";
  text: string;
};
