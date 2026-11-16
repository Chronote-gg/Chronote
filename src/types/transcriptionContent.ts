import type { MeetingData } from "./meeting-data";

export type TranscriptionContentInput = {
  tempDirectory?: string;
  meetingId: string;
  creator: { id: string };
  guild: { id: string };
  voiceChannel: { id: string };
  signal: AbortSignal;
  /** Only recovery of a recording frozen with a fixed language sets this. */
  languageHint?: string;
  runtimeConfig?: Pick<
    NonNullable<MeetingData["runtimeConfig"]>,
    "transcription" | "modelChoices"
  >;
  effect<T>(run: () => Promise<T>): Promise<T>;
};
