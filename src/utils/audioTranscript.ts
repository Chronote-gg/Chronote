import type { AudioData, AudioFileData } from "../types/audio";
import type { TranscriptionFacts } from "../types/meetingProcessing";
import { isTrivialTranscriptionText } from "./transcriptionText";

export function resolveAudioFileText(file: AudioFileData): string {
  const text =
    file.finalPassTranscript !== undefined
      ? file.finalPassTranscript
      : file.coalescedTranscript ||
        file.slowTranscript ||
        file.transcript ||
        file.fastTranscripts?.at(-1)?.text ||
        "";
  return isTrivialTranscriptionText(text) ? "" : text.trim();
}

export function getAudioTranscriptionFacts(
  audio: AudioData,
): TranscriptionFacts {
  const files = audio.audioFiles.filter((file) => file.source !== "bot");
  return {
    usableSegments: files.filter((file) => Boolean(resolveAudioFileText(file)))
      .length,
    failedSegments: files.filter((file) => file.transcriptionFailed).length,
    captureIncomplete: audio.captureIncomplete ?? false,
  };
}
