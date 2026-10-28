import type {
  SpeechAdmission,
  SpeechCoverage,
} from "../services/speechDetectionTypes";
import type {
  TranscriptCorrespondence,
  PcmSpan,
} from "./transcriptCorrespondence";
import { FfmpegCommand } from "fluent-ffmpeg";
import { PassThrough } from "node:stream";

export interface AudioSnippet {
  chunks: Buffer[];
  pcmSpans?: PcmSpan[];
  timestamp: number;
  userId: string;
  audioFileData?: AudioFileData;
  audioBytes?: number;
  fastRevision?: number;
  fastTranscribed?: boolean;
  lastFastTranscriptBytes?: number;
  lastFastSpeechCoverage?: SpeechCoverage;
  interjectionTriggered?: boolean;
  interjectionForced?: boolean;
}

export type TranscriptVariant = {
  revision: number;
  text: string;
  createdAt: string;
  correspondence?: TranscriptCorrespondence;
};

export type CoalesceMeta = {
  model: string;
  usedFastRevisions: number[];
  createdAt: string;
};

export type SnippetTranscriptionResult =
  | { status: "succeeded"; text: string; admission: SpeechAdmission }
  | { status: "skipped"; reason: "non_speech"; coverage: SpeechCoverage }
  | {
      status: "failed";
      reason: "transcription_error" | "conversion_error";
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
  transcriptCorrespondence?: TranscriptCorrespondence;
  slowCorrespondence?: TranscriptCorrespondence;
  coalescedCorrespondence?: TranscriptCorrespondence;
  finalPassCorrespondence?: TranscriptCorrespondence;
  terminalOmission?: TranscriptCorrespondence;
  finalPassTranscript?: string;
  fastTranscripts?: TranscriptVariant[];
  slowTranscript?: string;
  coalescedTranscript?: string;
  coalesceMeta?: CoalesceMeta;
  transcriptionFailed?: boolean;
  finalSpeechRejection?: SpeechCoverage;
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
  captureIncomplete?: boolean;
}
