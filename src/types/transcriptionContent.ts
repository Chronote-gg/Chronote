import type { MeetingData } from "./meeting-data";

export type TranscriptionContentInput = {
  tempDirectory?: string;
  meetingId: string;
  creator: { id: string };
  guild: { id: string };
  voiceChannel: { id: string };
  signal: AbortSignal;
  keywordRejectionScope?: object;
  /** Dictionary terms within the transcription budget, sent as recognition hints. */
  keywords: readonly string[];
  runtimeConfig?: Pick<
    NonNullable<MeetingData["runtimeConfig"]>,
    "transcription" | "modelChoices"
  >;
  effect<T>(run: () => Promise<T>): Promise<T>;
};
