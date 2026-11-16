import type { MeetingData } from "./meeting-data";

export type TranscriptionContentInput = {
  tempDirectory?: string;
  meetingId: string;
  creator: { id: string };
  guild: { id: string };
  voiceChannel: { id: string };
  signal: AbortSignal;
  runtimeConfig?: Pick<
    NonNullable<MeetingData["runtimeConfig"]>,
    "transcription" | "modelChoices"
  >;
  effect<T>(run: () => Promise<T>): Promise<T>;
};
