import type { AudioData, AudioFileData } from "../types/audio";
import type { TranscriptionFacts } from "../types/meetingProcessing";
import { isTrivialTranscriptionText } from "./transcriptionText";

export function isAudioFileSpeechRejected(file: AudioFileData): boolean {
  return file.finalSpeechRejection !== undefined;
}

export function resolveAudioFileTranscript(file: AudioFileData) {
  if (isAudioFileSpeechRejected(file))
    return { text: "", correspondence: file.terminalOmission };
  const selected =
    file.finalPassTranscript !== undefined
      ? {
          text: file.finalPassTranscript,
          correspondence: file.finalPassCorrespondence,
        }
      : file.coalescedTranscript
        ? {
            text: file.coalescedTranscript,
            correspondence: file.coalescedCorrespondence,
          }
        : file.slowTranscript
          ? {
              text: file.slowTranscript,
              correspondence: file.slowCorrespondence,
            }
          : file.transcript
            ? {
                text: file.transcript,
                correspondence: file.transcriptCorrespondence,
              }
            : (file.fastTranscripts?.at(-1) ?? {
                text: "",
                correspondence: undefined,
              });
  const text = isTrivialTranscriptionText(selected.text)
    ? ""
    : selected.text.trim();
  return {
    text,
    correspondence:
      !text && !file.processing
        ? (selected.correspondence ?? file.terminalOmission)
        : selected.correspondence,
  };
}
export function resolveAudioFileText(file: AudioFileData): string {
  return resolveAudioFileTranscript(file).text;
}

export function getAudioTranscriptionFacts(
  audio: AudioData,
): TranscriptionFacts {
  const files = audio.audioFiles.filter((file) => file.source !== "bot");
  return {
    usableSegments: files.filter((file) => Boolean(resolveAudioFileText(file)))
      .length,
    failedSegments: files.filter(
      (file) => !isAudioFileSpeechRejected(file) && file.transcriptionFailed,
    ).length,
    captureIncomplete: audio.captureIncomplete ?? false,
  };
}
