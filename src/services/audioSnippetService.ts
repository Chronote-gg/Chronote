import type {
  AudioSnippet,
  AudioFileData,
  TranscriptVariant,
} from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
import type {
  TranscriptCorrespondence,
  PcmSpan,
} from "../types/transcriptCorrespondence";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  RECORD_SAMPLE_RATE,
  FAST_SILENCE_THRESHOLD,
  SILENCE_THRESHOLD,
  MINIMUM_TRANSCRIPTION_LENGTH,
  MAX_SNIPPET_LENGTH,
} from "../constants";
import { resolveSpeakerLabel } from "./recordingSpeakerService";
import {
  evaluateNoiseGate,
  DEFAULT_NOISE_GATE_CONFIG,
  isNoiseGateEnabled,
} from "../utils/audioNoiseGate";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./meetingProcessingLifetime";
import {
  transcribeSnippet,
  coalesceTranscription,
} from "./transcriptionService";
import { checkpointCompletedTranscription } from "./recordingContentService";
import {
  copyCorrespondence,
  combineCorrespondence,
  containsPcmSpans,
  appendPcmSpan,
} from "../utils/transcriptCorrespondence";
import {
  DEFAULT_SPEECH_POLICY,
  speechCoverageMatches,
} from "./speechDetectionPolicy";
import { isTrivialTranscriptionText } from "../utils/transcriptionText";
import { nowIso } from "../utils/time";
import { maybeRespondLive } from "../liveVoice";
import { getModelChoice, buildModelOverrides } from "./modelFactory";

export function getAudioBytes(audio: AudioSnippet): number {
  if (typeof audio.audioBytes === "number") {
    return audio.audioBytes;
  }
  return audio.chunks.reduce((acc, cur) => acc + cur.length, 0);
}

type NoiseGateMode = "fast" | "slow";

const DEFAULT_TRANSCRIPTION_TIMING = {
  fastSilenceMs: FAST_SILENCE_THRESHOLD,
  slowSilenceMs: SILENCE_THRESHOLD,
  minSnippetSeconds: MINIMUM_TRANSCRIPTION_LENGTH,
  maxSnippetMs: MAX_SNIPPET_LENGTH,
  fastFinalizationEnabled: false,
  interjectionEnabled: false,
  interjectionMinSpeakerSeconds: MINIMUM_TRANSCRIPTION_LENGTH,
};

function formatDbfs(value: number): string {
  if (!Number.isFinite(value)) return "silence";
  return value.toFixed(1);
}

export function shouldSkipByNoiseGate(
  meeting: MeetingData,
  snippet: AudioSnippet,
  mode: NoiseGateMode,
): boolean {
  const runtimeConfig = meeting.runtimeConfig;
  const noiseGate = runtimeConfig
    ? runtimeConfig.transcription.noiseGate
    : DEFAULT_NOISE_GATE_CONFIG;
  if (!isNoiseGateEnabled(noiseGate, mode)) return false;
  if (snippet.chunks.length === 0) return false;

  const buffer = Buffer.concat(snippet.chunks, getAudioBytes(snippet));
  const result = evaluateNoiseGate(buffer, noiseGate, {
    sampleRate: RECORD_SAMPLE_RATE,
    channels: CHANNELS,
    bytesPerSample: BYTES_PER_SAMPLE,
  });
  if (result.shouldTranscribe) return false;

  const speakerLabel = resolveSpeakerLabel(meeting, snippet.userId);
  const logParts = [
    "Noise gate suppressed snippet:",
    "guildId=" + meeting.guildId,
    "channelId=" + meeting.channelId,
    "meetingId=" + meeting.meetingId,
    "userId=" + snippet.userId,
    "speaker=" + speakerLabel,
    "mode=" + mode,
    "peakDbfs=" + formatDbfs(result.metrics.peakDbfs),
    "noiseFloorDbfs=" + formatDbfs(result.metrics.noiseFloorDbfs),
    "activeWindows=" +
      result.metrics.activeWindowCount +
      "/" +
      result.metrics.totalWindows,
    "thresholdDbfs=" + result.metrics.thresholdDbfs,
    "minActiveWindows=" + result.metrics.minActiveWindows,
    "minPeakAboveNoiseDb=" + result.metrics.minPeakAboveNoiseDb,
  ];
  console.log(logParts.join(" "));

  return true;
}

function cloneSnippet(snippet: AudioSnippet): AudioSnippet {
  return {
    ...snippet,
    chunks: [...snippet.chunks],
    pcmSpans: snippet.pcmSpans?.map((span) => ({ ...span })),
  };
}

export function getTranscriptionTiming(meeting: MeetingData) {
  const runtimeConfig = meeting.runtimeConfig;
  if (!runtimeConfig) {
    return { ...DEFAULT_TRANSCRIPTION_TIMING };
  }
  const transcription = runtimeConfig.transcription;
  return {
    fastSilenceMs: transcription.fastSilenceMs,
    slowSilenceMs: transcription.slowSilenceMs,
    minSnippetSeconds: transcription.minSnippetSeconds,
    maxSnippetMs: transcription.maxSnippetMs,
    fastFinalizationEnabled: transcription.fastFinalizationEnabled,
    interjectionEnabled: transcription.interjectionEnabled,
    interjectionMinSpeakerSeconds: transcription.interjectionMinSpeakerSeconds,
  };
}

export function getOrCreateAudioFileData(
  meeting: MeetingData,
  snippet: AudioSnippet,
): AudioFileData {
  if (snippet.audioFileData) {
    return snippet.audioFileData;
  }

  const audioFileData: AudioFileData = {
    timestamp: snippet.timestamp,
    userId: snippet.userId,
    source: "voice",
    processing: true,
    audioOnlyProcessing: false, // Audio already written in real-time
  };

  audioFileData.audioOnlyProcessingPromise = Promise.resolve();

  meeting.audioData.audioFiles.push(audioFileData);
  snippet.audioFileData = audioFileData;

  return audioFileData;
}

export function runFastTranscription(
  meeting: MeetingData,
  snippet: AudioSnippet,
) {
  if (snippet.chunks.length === 0) return;

  const { minSnippetSeconds } = getTranscriptionTiming(meeting);
  const duration = getAudioDuration(snippet);
  if (duration <= minSnippetSeconds) {
    return;
  }

  const audioFileData = getOrCreateAudioFileData(meeting, snippet);
  const revision = (snippet.fastRevision ?? 0) + 1;
  snippet.fastRevision = revision;

  const snapshot = cloneSnippet(snippet);
  const snapshotBytes = getAudioBytes(snapshot);
  if (shouldSkipByNoiseGate(meeting, snapshot, "fast")) {
    return;
  }
  void runMeetingProcessingEffect(meeting, () =>
    transcribeSnippet(meeting, snapshot, {
      tempSuffix: `fast-${revision}`,
      noiseGateMode: "fast",
    })
      .then((result) => {
        if (
          getMeetingProcessingSignal(meeting).aborted ||
          snippet.fastRevision !== revision ||
          meeting.audioData.currentSnippets.get(snippet.userId) !== snippet ||
          audioFileData.finalSpeechRejection
        )
          return;
        if (result.status === "skipped") {
          snippet.lastFastSpeechCoverage = undefined;
          return;
        }
        if (result.status === "failed") {
          return;
        }
        const transcription = result.text;
        snippet.lastFastSpeechCoverage = undefined;
        if (!transcription.trim()) {
          return;
        }
        const entry = {
          revision,
          text: transcription,
          correspondence: snapshot.pcmSpans
            ? {
                kind: "pcm" as const,
                spans: snapshot.pcmSpans.map((span) => ({ ...span })),
              }
            : undefined,
          createdAt: nowIso(),
        };
        if (!audioFileData.fastTranscripts) {
          audioFileData.fastTranscripts = [];
        }
        audioFileData.fastTranscripts.push(entry);
        audioFileData.transcript = transcription;
        audioFileData.transcriptCorrespondence = copyCorrespondence(
          entry.correspondence,
        );
        snippet.lastFastSpeechCoverage =
          result.admission.kind === "assessed" &&
          result.admission.assessment.kind === "speech" &&
          !isTrivialTranscriptionText(transcription)
            ? result.admission.coverage
            : undefined;
        checkpointCompletedTranscription(meeting);
        snippet.fastTranscribed = true;
        snippet.lastFastTranscriptBytes = snapshotBytes;
        void runMeetingProcessingEffect(meeting, () =>
          maybeRespondLive(meeting, {
            userId: snippet.userId,
            text: transcription,
            timestamp: snippet.timestamp,
          }),
        ).catch(() => {});
      })
      .catch((error) => {
        console.error(
          `Failed to transcribe fast snippet for user ${snippet.userId}:`,
          error,
        );
      }),
  ).catch(() => {});
}

/** Coalescing may only use fast candidates inside the finalized snippet input. */
function validateFastCandidateCorrespondence(
  inputCorrespondence: TranscriptCorrespondence | undefined,
  fastCandidates: readonly TranscriptVariant[],
): void {
  if (
    inputCorrespondence?.kind === "pcm" &&
    fastCandidates.some(
      (entry) =>
        entry.correspondence?.kind === "pcm" &&
        !containsPcmSpans(
          inputCorrespondence.spans,
          entry.correspondence.spans,
        ),
    )
  )
    throw new Error("Fast transcript input exceeds finalized snippet");
}

export function canReuseFastTranscript(
  meeting: MeetingData,
  snippet: AudioSnippet,
  audioFileData: AudioFileData,
  latestFastText: string | undefined,
  forceTranscribe?: boolean,
): boolean {
  const { fastFinalizationEnabled } = getTranscriptionTiming(meeting);
  const hasAudio = snippet.chunks.length > 0;
  const mode =
    meeting.runtimeConfig?.transcription.speechDetectionMode ?? "off";
  return (
    fastFinalizationEnabled &&
    !forceTranscribe &&
    hasAudio &&
    Boolean(latestFastText) &&
    snippet.lastFastTranscriptBytes !== undefined &&
    getAudioBytes(snippet) === snippet.lastFastTranscriptBytes &&
    !audioFileData.finalSpeechRejection &&
    (mode !== "enforce" ||
      (snippet.lastFastSpeechCoverage !== undefined &&
        !isTrivialTranscriptionText(latestFastText ?? "") &&
        speechCoverageMatches(
          Buffer.concat(snippet.chunks),
          snippet.lastFastSpeechCoverage,
          DEFAULT_SPEECH_POLICY.policyFingerprint,
        )))
  );
}
export async function coalesceSnippetTranscription(
  meeting: MeetingData,
  snippet: AudioSnippet,
  audioFileData: AudioFileData,
  inputCorrespondence: TranscriptCorrespondence | undefined,
  transcription: string,
): Promise<void> {
  const premium = meeting.runtimeConfig?.premiumTranscription;
  if (
    premium?.enabled &&
    transcription.trim().length > 0 &&
    audioFileData.fastTranscripts &&
    audioFileData.fastTranscripts.length > 0
  ) {
    try {
      const fastCandidates = audioFileData.fastTranscripts.map((entry) => ({
        ...entry,
        correspondence: copyCorrespondence(entry.correspondence),
      }));
      validateFastCandidateCorrespondence(inputCorrespondence, fastCandidates);
      const coalesced = await coalesceTranscription(meeting, {
        slowTranscript: transcription,
        fastTranscripts: fastCandidates,
      });
      if (getMeetingProcessingSignal(meeting).aborted) return;
      if (coalesced && coalesced.trim().length > 0) {
        audioFileData.coalescedTranscript = coalesced;
        audioFileData.coalescedCorrespondence = combineCorrespondence([
          inputCorrespondence,
          ...fastCandidates.map((entry) => entry.correspondence),
        ]);
        audioFileData.coalesceMeta = {
          model: getModelChoice(
            "transcriptionCoalesce",
            buildModelOverrides(meeting.runtimeConfig?.modelChoices),
          ).model,
          usedFastRevisions: audioFileData.fastTranscripts.map(
            (entry) => entry.revision,
          ),
          createdAt: nowIso(),
        };
        audioFileData.transcript = coalesced;
        audioFileData.transcriptCorrespondence = copyCorrespondence(
          audioFileData.coalescedCorrespondence,
        );
      }
    } catch (error) {
      console.error(
        `Failed to coalesce transcription for user ${snippet.userId}:`,
        error,
      );
    }
  }
}

export function appendSnippetPcm(
  snippet: AudioSnippet,
  chunk: Buffer,
  acceptedSpan: PcmSpan | undefined,
): void {
  if (acceptedSpan) {
    if (!snippet.chunks.length) snippet.pcmSpans = [];
    if (snippet.pcmSpans) appendPcmSpan(snippet.pcmSpans, acceptedSpan);
  } else snippet.pcmSpans = undefined;
  snippet.chunks.push(chunk);
  snippet.audioBytes = (snippet.audioBytes ?? 0) + chunk.length;
}

function getAudioDuration(audio: AudioSnippet): number {
  return (
    getAudioBytes(audio) / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)
  );
}
