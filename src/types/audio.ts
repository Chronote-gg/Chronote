import { FfmpegCommand } from "fluent-ffmpeg";
import { PassThrough } from "node:stream";

export interface AudioSnippet {
  chunks: Buffer[];
  timestamp: number;
  userId: string;
  audioFileData?: AudioFileData;
  audioBytes?: number;
  fastRevision?: number;
  fastTranscribed?: boolean;
  lastFastTranscriptBytes?: number;
  interjectionTriggered?: boolean;
  interjectionForced?: boolean;
}

export type TranscriptVariant = {
  revision: number;
  text: string;
  createdAt: string;
};

export type CoalesceMeta = {
  model: string;
  usedFastRevisions: number[];
  createdAt: string;
};

export type AudioSegmentSource = "voice" | "chat_tts" | "bot";
export interface AudioCueEvent {
  userId: string;
  timestamp: number;
  text: string;
  source?: AudioSegmentSource;
}

export type SpeakerState = {
  active: boolean;
  lastStartMs?: number;
  lastEndMs?: number;
};

export interface AudioFileData {
  userId: string;
  timestamp: number;
  transcript?: string;
  finalPassTranscript?: string;
  fastTranscripts?: TranscriptVariant[];
  slowTranscript?: string;
  coalescedTranscript?: string;
  coalesceMeta?: CoalesceMeta;
  source?: AudioSegmentSource;
  messageId?: string;
  processing: boolean;
  processingPromise?: Promise<void>;
  audioOnlyProcessing: boolean; //Is just the audio finished (don't worry about transcriptions which may be slower)
  audioOnlyProcessingPromise?: Promise<void>;
}

export interface SpeakerTrackFile {
  filePath: string;
  userId: string;
  lastEndMs: number;
  source?: AudioSegmentSource;
  writePromise?: Promise<void>;
  writeFailed?: boolean;
  writeFailureCount?: number;
}

export interface AudioData {
  currentSnippets: Map<string, AudioSnippet>; // Map of userId to their current AudioSnippet
  silenceTimers?: Map<string, { fast?: NodeJS.Timeout; slow?: NodeJS.Timeout }>; // Optional: Map of userId to their silence timers
  speakerStates?: Map<string, SpeakerState>;
  audioFiles: AudioFileData[];
  cueEvents?: AudioCueEvent[];
  audioPassThrough?: PassThrough;
  outputFileName?: string;
  ffmpegProcess?: FfmpegCommand;
  speakerTracks?: Map<string, SpeakerTrackFile>;
  speakerTrackDir?: string;
  missingStartWarnings?: Set<string>;
}
