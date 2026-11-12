import type { ChatMeetingInput } from "../services/openaiChatService";
import type {
  getTranscriptionPrompt,
  getTranscriptionFinalPassPrompt,
} from "../services/transcriptionPromptService";
import type { MeetingData } from "./meeting-data";
import type {
  FinalPassSettings,
  SavedRecordingSettings,
} from "./recordingContent";
import type { TranscriptionLanguage } from "../config/transcriptionLanguage";

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
  prompt(): ReturnType<typeof getTranscriptionPrompt>;
  effect<T>(run: () => Promise<T>): Promise<T>;
};

export type FinalPassContent = ChatMeetingInput & {
  startTime: Date;
  endTime?: Date;
  participants: MeetingData["participants"];
  audioData: Pick<MeetingData["audioData"], "audioFiles">;
  signal: AbortSignal;
  enabled: boolean;
  settings: FinalPassSettings;
  langfuseParentSpanContext?: MeetingData["langfuseParentSpanContext"];
  transcriptionModel: string;
  transcriptionLanguage: TranscriptionLanguage;
  reconcileModel: SavedRecordingSettings["models"]["notes"];
  prompt(): ReturnType<typeof getTranscriptionPrompt>;
  finalPassPrompt(
    input: Parameters<typeof getTranscriptionFinalPassPrompt>[1],
  ): ReturnType<typeof getTranscriptionFinalPassPrompt>;
  effect<T>(run: () => Promise<T>): Promise<T>;
};
