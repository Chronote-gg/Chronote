import type {
  PcmSpan,
  TranscriptCorrespondence,
} from "./types/transcriptCorrespondence";
import {
  appendPcmSpan,
  copyCorrespondence,
  combineCorrespondence,
  containsPcmSpans,
} from "./utils/transcriptCorrespondence";
import { renderMixedPcmTracks } from "./services/mixedPcmService";
import { handleRecordingCaptureFailure } from "./services/recordingCaptureFailure";
import { finished } from "node:stream/promises";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./services/meetingProcessingLifetime";
import {
  startRecordingContentCheckpoint,
  checkpointCompletedTranscription,
  checkpointRecordingContext,
} from "./services/recordingContentService";
import { createRecordingCheckpointCapture } from "./services/recordingCheckpointCapture";
import { appendMeetingCheckpointArtifacts } from "./services/recordingCheckpointService";
import {
  DEFAULT_SPEECH_POLICY,
  speechCoverageMatches,
} from "./services/speechDetectionPolicy";
import { isTrivialTranscriptionText } from "./utils/transcriptionText";
import {
  recordSpeechCapturedAudio,
  recordSpeechSnippetOutcome,
} from "./metrics";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  FAST_SILENCE_THRESHOLD,
  FRAME_SIZE,
  MAX_SNIPPET_LENGTH,
  MINIMUM_TRANSCRIPTION_LENGTH,
  RECORD_SAMPLE_RATE,
  SILENCE_THRESHOLD,
} from "./constants";
import {
  AudioFileData,
  AudioSnippet,
  SpeakerState,
  SpeakerTrackFile,
  TranscriptVariant,
} from "./types/audio";
import { MeetingData } from "./types/meeting-data";
import { EndBehaviorType, VoiceConnectionStatus } from "@discordjs/voice";
import { OpusDiagnosticDecoder } from "./utils/opusDiagnosticDecoder";
import { disposeVoiceStream } from "./utils/disposeVoiceStream";
import { PassThrough, Readable } from "node:stream";
import {
  coalesceTranscription,
  transcribeSnippet,
} from "./services/transcriptionService";
import { formatParticipantLabel } from "./utils/participants";
import { buildModelOverrides, getModelChoice } from "./services/modelFactory";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "node:fs";
import path from "node:path";
import { maybeRespondLive } from "./liveVoice";
import { nowIso } from "./utils/time";
import {
  ensureMeetingTempDir,
  ensureMeetingTempDirSync,
  getMeetingTempDir,
} from "./services/tempFileService";
import {
  evaluateNoiseGate,
  DEFAULT_NOISE_GATE_CONFIG,
  isNoiseGateEnabled,
} from "./utils/audioNoiseGate";

function generateSilentBuffer(
  durationMs: number,
  sampleRate: number,
  channels: number,
): Buffer {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate) * channels;
  return Buffer.alloc(numSamples * BYTES_PER_SAMPLE);
}

function generateNewSnippet(userId: string, timestamp?: number): AudioSnippet {
  return {
    chunks: [],
    audioBytes: 0,
    timestamp: timestamp ?? Date.now(),
    userId,
    fastRevision: 0,
    fastTranscribed: false,
  };
}

type SnippetProcessingOptions = {
  forceTranscribe?: boolean;
  skipLiveVoice?: boolean;
};

type SnippetTimers = {
  fast?: NodeJS.Timeout;
  slow?: NodeJS.Timeout;
};

type OpusDecoder = OpusDiagnosticDecoder;

type VoiceSubscriptionState = {
  opusStream: Readable;
  decoder: OpusDecoder;
  decodedStream: Readable;
  ownedListenerCleanups: Map<Readable, (() => void)[]>;
  lastPcmAt?: number;
  decoderErrorCount: number;
  consecutiveNoPcmEvents: number;
  lastNoPcmAt?: number;
  resubscribeTimer?: ReturnType<typeof setTimeout>;
  suppressResubscribe?: boolean;
};

const RESUBSCRIBE_DELAY_MS = 250;
const NO_PCM_MIN_DURATION_MS = 800;
const NO_PCM_RESUBSCRIBE_THRESHOLD = 2;
const NO_PCM_RESUBSCRIBE_WINDOW_MS = 60_000;

const voiceSubscriptions = new WeakMap<
  MeetingData,
  Map<string, VoiceSubscriptionState>
>();

function getSpeakerStates(meeting: MeetingData): Map<string, SpeakerState> {
  if (!meeting.audioData.speakerStates) {
    meeting.audioData.speakerStates = new Map();
  }
  return meeting.audioData.speakerStates;
}

function getSpeakerState(
  meeting: MeetingData,
  userId: string,
): SpeakerState | undefined {
  return getSpeakerStates(meeting).get(userId);
}

function warnMissingSnippetStart(meeting: MeetingData, userId: string) {
  if (!meeting.audioData.missingStartWarnings) {
    meeting.audioData.missingStartWarnings = new Set();
  }
  if (meeting.audioData.missingStartWarnings.has(userId)) {
    return;
  }
  meeting.audioData.missingStartWarnings.add(userId);
  const speakerLabel = resolveSpeakerLabel(meeting, userId);
  console.warn(
    `Missing speaking start timestamp, using receipt time for snippet: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${userId} speaker=${speakerLabel}`,
  );
}

function getVoiceSubscriptions(
  meeting: MeetingData,
): Map<string, VoiceSubscriptionState> {
  const existing = voiceSubscriptions.get(meeting);
  if (existing) {
    return existing;
  }
  const created = new Map<string, VoiceSubscriptionState>();
  voiceSubscriptions.set(meeting, created);
  return created;
}

function resolveSpeakerLabel(meeting: MeetingData, userId: string): string {
  const participant = meeting.participants?.get(userId);
  if (!participant) return userId;
  return formatParticipantLabel(participant, {
    includeUsername: true,
    fallbackName: participant.username ?? userId,
  });
}

const captureStreamClosures = new WeakMap<MeetingData, Set<Promise<void>>>();
export async function waitForCaptureStreamSettlement(
  meeting: MeetingData,
): Promise<void> {
  const pending = captureStreamClosures.get(meeting);
  while (pending?.size) await Promise.all([...pending]);
}
function closeCaptureStream(
  meeting: MeetingData,
  stream: Readable,
  detachOwnedListeners: () => void,
) {
  if (!stream.closed) {
    let pending = captureStreamClosures.get(meeting);
    if (!pending) {
      pending = new Set();
      captureStreamClosures.set(meeting, pending);
    }
    const closed = new Promise<void>((resolve) =>
      stream.once("close", resolve),
    );
    pending.add(closed);
    void closed.then(() => pending.delete(closed));
  }
  disposeVoiceStream(stream, detachOwnedListeners);
}
function clearVoiceSubscription(
  meeting: MeetingData,
  userId: string,
  expected?: VoiceSubscriptionState,
) {
  const subscriptions = getVoiceSubscriptions(meeting);
  const existing = expected ?? subscriptions.get(userId);
  if (!existing) return;

  existing.suppressResubscribe = true;
  if (existing.resubscribeTimer) clearTimeout(existing.resubscribeTimer);
  existing.resubscribeTimer = undefined;
  if (subscriptions.get(userId) === existing) subscriptions.delete(userId);

  if (
    meeting.connection.receiver.subscriptions.get(userId) ===
    existing.opusStream
  ) {
    meeting.connection.receiver.subscriptions.delete(userId);
  }

  for (const stream of new Set([
    existing.opusStream,
    existing.decoder,
    existing.decodedStream,
  ])) {
    closeCaptureStream(meeting, stream, () => {
      for (const detach of existing.ownedListenerCleanups.get(stream) ?? []) {
        detach();
      }
    });
  }
  existing.ownedListenerCleanups.clear();
}

function scheduleResubscribe(
  meeting: MeetingData,
  userId: string,
  reason: string,
) {
  if (!isCaptureActive(meeting)) return;
  if (!meeting.voiceChannel.members.has(userId)) {
    return;
  }
  const subscriptions = getVoiceSubscriptions(meeting);
  const existing = subscriptions.get(userId);
  if (existing?.resubscribeTimer) {
    return;
  }

  console.log(
    `Scheduling voice resubscribe: meetingId=${meeting.meetingId} reason=${reason}`,
  );

  const timer = setTimeout(() => {
    if (!existing || subscriptions.get(userId) !== existing) return;
    existing.resubscribeTimer = undefined;
    if (existing.suppressResubscribe) return;
    if (!isCaptureActive(meeting)) return;
    if (!meeting.voiceChannel.members.has(userId)) return;
    void runMeetingProcessingEffect(meeting, () =>
      subscribeToUserVoice(meeting, userId),
    ).catch(() => {
      if (
        getMeetingProcessingSignal(meeting).aborted ||
        subscriptions.has(userId)
      )
        return;
      console.warn("Voice subscription replacement failed:", {
        meetingId: meeting.meetingId,
        stage: "resubscribe",
      });
    });
  }, RESUBSCRIBE_DELAY_MS);

  if (existing) {
    existing.resubscribeTimer = timer;
  }
}

function isCaptureIntakeStopped(meeting: MeetingData): boolean {
  return (
    meeting.finishing ||
    meeting.captureAudio === false ||
    meeting.ownershipSignal?.aborted === true
  );
}
function isCaptureActive(meeting: MeetingData): boolean {
  return (
    !isCaptureIntakeStopped(meeting) &&
    meeting.connection.state.status !== VoiceConnectionStatus.Destroyed
  );
}

function markSpeakerStart(meeting: MeetingData, userId: string) {
  const states = getSpeakerStates(meeting);
  const existing = states.get(userId) ?? { active: false };
  states.set(userId, { ...existing, active: true, lastStartMs: Date.now() });
  meeting.audioData.speakerStates = states;
}

function markSpeakerEnd(meeting: MeetingData, userId: string) {
  const states = getSpeakerStates(meeting);
  const existing = states.get(userId) ?? { active: false };
  states.set(userId, { ...existing, active: false, lastEndMs: Date.now() });
  meeting.audioData.speakerStates = states;
}

function getAudioBytes(audio: AudioSnippet): number {
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

function shouldSkipByNoiseGate(
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

function getTranscriptionTiming(meeting: MeetingData) {
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

const SPEAKER_TRACK_SILENCE_CHUNK_MS = 250;

function getSpeakerTrackDir(meeting: MeetingData): string {
  if (meeting.audioData.speakerTrackDir) {
    return meeting.audioData.speakerTrackDir;
  }
  const dir = path.join(getMeetingTempDir(meeting), "t");
  meeting.audioData.speakerTrackDir = dir;
  return dir;
}

function getSpeakerTracks(meeting: MeetingData): Map<string, SpeakerTrackFile> {
  if (!meeting.audioData.speakerTracks) {
    meeting.audioData.speakerTracks = new Map();
  }
  return meeting.audioData.speakerTracks;
}

function getOrCreateSpeakerTrack(
  meeting: MeetingData,
  userId: string,
): SpeakerTrackFile {
  const tracks = getSpeakerTracks(meeting);
  const existing = tracks.get(userId);
  if (existing) return existing;
  const dir = getSpeakerTrackDir(meeting);
  const track: SpeakerTrackFile = {
    userId,
    filePath: path.join(dir, `t_${userId}.pcm`),
    lastEndMs: 0,
    source: "voice",
    writeFailed: false,
    writeFailureCount: 0,
  };
  tracks.set(userId, track);
  return track;
}

async function appendBufferToStream(
  outputStream: fs.WriteStream,
  buffer: Buffer,
): Promise<void> {
  if (buffer.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    outputStream.write(buffer, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function appendSilenceToStream(
  outputStream: fs.WriteStream,
  durationMs: number,
): Promise<void> {
  let remainingMs = durationMs;
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, SPEAKER_TRACK_SILENCE_CHUNK_MS);
    const silence = generateSilentBuffer(chunkMs, RECORD_SAMPLE_RATE, CHANNELS);
    await appendBufferToStream(outputStream, silence);
    remainingMs -= chunkMs;
  }
}

async function persistSnippetSpeakerTrack(
  meeting: MeetingData,
  snippet: AudioSnippet,
) {
  if (snippet.chunks.length === 0) return;

  const buffer = Buffer.concat(snippet.chunks);
  const durationMs = Math.round(
    (buffer.length / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
  );
  if (durationMs <= 0) return;

  const offsetMs = Math.max(0, snippet.timestamp - meeting.startTime.getTime());
  const track = getOrCreateSpeakerTrack(meeting, snippet.userId);
  const writeTask = async () => {
    await fs.promises.mkdir(getSpeakerTrackDir(meeting), { recursive: true });
    const outputStream = fs.createWriteStream(track.filePath, { flags: "a" });
    const actualClose = new Promise<void>((resolve) =>
      outputStream.once("close", resolve),
    );
    const closed = finished(outputStream, { cleanup: true });
    void closed.catch(() => {});
    try {
      const gapMs = Math.max(0, offsetMs - track.lastEndMs);
      if (gapMs > 0) {
        await appendSilenceToStream(outputStream, gapMs);
      }
      await appendBufferToStream(outputStream, buffer);
      await new Promise<void>((resolve, reject) => {
        outputStream.end(() => resolve());
        outputStream.on("error", (error) => reject(error));
      });
      await closed;
      track.lastEndMs = Math.max(track.lastEndMs, offsetMs + durationMs);
    } catch (error) {
      console.error(
        `Failed to persist speaker track for user ${snippet.userId}:`,
        error,
      );
      outputStream.destroy();
      track.writeFailed = true;
      track.writeFailureCount = (track.writeFailureCount ?? 0) + 1;
    } finally {
      await closed.catch(() => {});
      await actualClose;
    }
  };

  const chained = (track.writePromise ?? Promise.resolve())
    .catch((error) => {
      console.error(
        `Previous speaker track write failed for user ${snippet.userId}:`,
        error,
      );
      return undefined;
    })
    .then(writeTask);
  track.writePromise = chained;
  await chained;
}

function getOrCreateAudioFileData(
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

function runFastTranscription(meeting: MeetingData, snippet: AudioSnippet) {
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

// Handle snippets based on the user speaking
export function updateSnippetsIfNecessary(
  meeting: MeetingData,
  userId: string,
  options: { startTimestamp?: number } = {},
): void {
  let snippet = meeting.audioData.currentSnippets.get(userId);

  if (!snippet) {
    if (options.startTimestamp === undefined) {
      warnMissingSnippetStart(meeting, userId);
    }
    snippet = generateNewSnippet(userId, options.startTimestamp);
    meeting.audioData.currentSnippets.set(userId, snippet);
  } else {
    const elapsedTime = Date.now() - snippet.timestamp;
    const { maxSnippetMs } = getTranscriptionTiming(meeting);
    if (elapsedTime >= maxSnippetMs) {
      startProcessingSnippet(meeting, userId);
      snippet = generateNewSnippet(userId);
      meeting.audioData.currentSnippets.set(userId, snippet);
    }
  }
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

// Start processing a specific user's snippet
export function startProcessingSnippet(
  meeting: MeetingData,
  userId: string,
  options: SnippetProcessingOptions = {},
) {
  const snippet = meeting.audioData.currentSnippets.get(userId);
  if (!snippet) return;

  const finalizationStartedAt = performance.now();
  if (getMeetingProcessingSignal(meeting).aborted) return;
  const speakerWrite = runMeetingProcessingEffect(meeting, () =>
    persistSnippetSpeakerTrack(meeting, snippet),
  );
  snippet.fastRevision = (snippet.fastRevision ?? 0) + 1;

  const audioFileData = getOrCreateAudioFileData(meeting, snippet);
  audioFileData.processing = true;

  const promises: Promise<void>[] = [speakerWrite];
  const inputCorrespondence: TranscriptCorrespondence | undefined =
    snippet.pcmSpans
      ? { kind: "pcm", spans: snippet.pcmSpans.map((span) => ({ ...span })) }
      : undefined;

  const { minSnippetSeconds, fastFinalizationEnabled } =
    getTranscriptionTiming(meeting);
  const duration = getAudioDuration(snippet);
  const hasAudio = snippet.chunks.length > 0;
  const latestFastTranscript =
    audioFileData.fastTranscripts?.[audioFileData.fastTranscripts.length - 1];
  const latestFastText =
    latestFastTranscript && latestFastTranscript.text.trim().length > 0
      ? latestFastTranscript.text
      : undefined;
  const mode =
    meeting.runtimeConfig?.transcription.speechDetectionMode ?? "off";
  const fastCoversSnippet =
    fastFinalizationEnabled &&
    !options.forceTranscribe &&
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
        )));
  if (fastCoversSnippet && latestFastText) {
    const participant = meeting.participants?.get(snippet.userId);
    const speakerLabel = participant
      ? formatParticipantLabel(participant, {
          includeUsername: true,
          fallbackName: participant.username ?? snippet.userId,
        })
      : snippet.userId;
    console.log(
      `Fast transcript covers snippet, skipping slow transcription: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${snippet.userId} speaker=${speakerLabel} duration=${duration.toFixed(2)}s bytes=${getAudioBytes(snippet)}`,
    );
    audioFileData.transcriptionFailed = false;
    audioFileData.transcript = latestFastText;
    recordSpeechSnippetOutcome({
      mode,
      phase: "slow",
      outcome: "reused",
      audioSeconds: duration,
      durationMs: performance.now() - finalizationStartedAt,
    });
    audioFileData.transcriptCorrespondence = copyCorrespondence(
      latestFastTranscript?.correspondence,
    );
  } else if (
    hasAudio &&
    (duration > minSnippetSeconds || options.forceTranscribe)
  ) {
    if (
      options.forceTranscribe ||
      !shouldSkipByNoiseGate(meeting, snippet, "slow")
    ) {
      promises.push(
        runMeetingProcessingEffect(meeting, () =>
          transcribeSnippet(meeting, snippet, {
            noiseGateMode: "slow",
            reuseTranscript:
              fastFinalizationEnabled &&
              latestFastText &&
              snippet.lastFastSpeechCoverage
                ? {
                    text: latestFastText,
                    coverage: snippet.lastFastSpeechCoverage,
                  }
                : undefined,
            speechDetectionBypass: options.forceTranscribe,
            noiseGateEnabledOverride: options.forceTranscribe
              ? false
              : undefined,
            suppressionEnabledOverride: options.forceTranscribe
              ? false
              : undefined,
          })
            .then(async (result) => {
              if (getMeetingProcessingSignal(meeting).aborted) return;
              if (result.status === "failed") {
                audioFileData.transcriptionFailed = true;
                return;
              }
              if (result.status === "skipped") {
                audioFileData.transcriptionFailed = false;
                audioFileData.finalSpeechRejection = result.coverage;
                return;
              }
              const transcription = result.text;
              audioFileData.transcriptionFailed = false;
              audioFileData.slowTranscript = transcription;
              audioFileData.slowCorrespondence =
                copyCorrespondence(inputCorrespondence);
              audioFileData.transcript = transcription;
              audioFileData.transcriptCorrespondence =
                copyCorrespondence(inputCorrespondence);
              if (!transcription.trim())
                audioFileData.terminalOmission =
                  copyCorrespondence(inputCorrespondence);
              checkpointCompletedTranscription(meeting);
              if (!options.skipLiveVoice) {
                void runMeetingProcessingEffect(meeting, () =>
                  maybeRespondLive(meeting, {
                    userId: snippet.userId,
                    text: transcription,
                    timestamp: snippet.timestamp,
                  }),
                ).catch(() => {});
              }

              const premium = meeting.runtimeConfig?.premiumTranscription;
              if (
                premium?.enabled &&
                transcription.trim().length > 0 &&
                audioFileData.fastTranscripts &&
                audioFileData.fastTranscripts.length > 0
              ) {
                try {
                  const fastCandidates = audioFileData.fastTranscripts.map(
                    (entry) => ({
                      ...entry,
                      correspondence: copyCorrespondence(entry.correspondence),
                    }),
                  );
                  validateFastCandidateCorrespondence(
                    inputCorrespondence,
                    fastCandidates,
                  );
                  const coalesced = await coalesceTranscription(meeting, {
                    slowTranscript: transcription,
                    fastTranscripts: fastCandidates,
                  });
                  if (getMeetingProcessingSignal(meeting).aborted) return;
                  if (coalesced && coalesced.trim().length > 0) {
                    audioFileData.coalescedTranscript = coalesced;
                    audioFileData.coalescedCorrespondence =
                      combineCorrespondence([
                        inputCorrespondence,
                        ...fastCandidates.map((entry) => entry.correspondence),
                      ]);
                    audioFileData.coalesceMeta = {
                      model: getModelChoice(
                        "transcriptionCoalesce",
                        buildModelOverrides(
                          meeting.runtimeConfig?.modelChoices,
                        ),
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
            })
            .catch((error) => {
              console.error(
                `Failed to transcribe snippet for user ${snippet.userId}:`,
                error,
              );
            }),
        ),
      );
    } else
      audioFileData.terminalOmission = copyCorrespondence(inputCorrespondence);
  } else {
    audioFileData.terminalOmission = copyCorrespondence(inputCorrespondence);
    const participant = meeting.participants?.get(snippet.userId);
    const speakerLabel = participant
      ? formatParticipantLabel(participant, {
          includeUsername: true,
          fallbackName: participant.username ?? snippet.userId,
        })
      : snippet.userId;
    const audioBytes = getAudioBytes(snippet);
    console.log(
      `Snippet less than minimum transcription length, not transcribing: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${snippet.userId} speaker=${speakerLabel} duration=${duration.toFixed(2)}s bytes=${audioBytes} timestamp=${snippet.timestamp}`,
    );
  }

  // Audio is now written immediately as it arrives, so we don't need to write it here
  // This prevents duplicate audio and memory buildup for long recordings

  audioFileData.processingPromise = runMeetingProcessingEffect(meeting, () =>
    Promise.all(promises).then(() => {
      audioFileData.processing = false;
      if (!getMeetingProcessingSignal(meeting).aborted)
        checkpointCompletedTranscription(meeting);
    }),
  );

  meeting.audioData.currentSnippets.delete(userId); // Remove snippet after processing
}

function maybeFinalizeSnippetsForInterjection(
  meeting: MeetingData,
  interjectorId: string,
  interjectorSnippet: AudioSnippet,
) {
  const { interjectionEnabled, interjectionMinSpeakerSeconds, slowSilenceMs } =
    getTranscriptionTiming(meeting);
  if (!interjectionEnabled) return;
  if (interjectorSnippet.interjectionTriggered) return;
  const duration = getAudioDuration(interjectorSnippet);
  if (duration < interjectionMinSpeakerSeconds) return;

  interjectorSnippet.interjectionTriggered = true;
  const interjectionStartMs =
    getSpeakerState(meeting, interjectorId)?.lastStartMs ??
    interjectorSnippet.timestamp;

  meeting.audioData.currentSnippets.forEach((snippet, userId) => {
    if (userId === interjectorId) return;
    if (snippet.interjectionForced) return;
    const state = getSpeakerState(meeting, userId);
    if (!state || state.active || !state.lastEndMs) return;
    if (interjectionStartMs < state.lastEndMs) return;
    if (interjectionStartMs - state.lastEndMs > slowSilenceMs) return;
    snippet.interjectionForced = true;
    clearSnippetTimer(meeting, userId);
    startProcessingSnippet(meeting, userId, {
      skipLiveVoice: Boolean(snippet.fastTranscribed),
    });
  });
}

// Set timers to run fast transcription and finalize the snippet after silence
function setSnippetTimer(meeting: MeetingData, userId: string) {
  const currentTimers =
    meeting.audioData.silenceTimers || new Map<string, SnippetTimers>();
  const existing = currentTimers.get(userId) ?? {};

  if (existing.fast) {
    clearTimeout(existing.fast);
  }
  if (existing.slow) {
    clearTimeout(existing.slow);
  }

  const { fastSilenceMs, slowSilenceMs } = getTranscriptionTiming(meeting);

  existing.fast = setTimeout(() => {
    const snippet = meeting.audioData.currentSnippets.get(userId);
    if (!snippet) return;
    runFastTranscription(meeting, snippet);
    const next = currentTimers.get(userId);
    if (next) {
      next.fast = undefined;
    }
  }, fastSilenceMs);

  existing.slow = setTimeout(() => {
    const snippet = meeting.audioData.currentSnippets.get(userId);
    if (!snippet) {
      currentTimers.delete(userId);
      return;
    }
    startProcessingSnippet(meeting, userId, {
      skipLiveVoice: Boolean(snippet.fastTranscribed),
    });
    currentTimers.delete(userId);
  }, slowSilenceMs);

  currentTimers.set(userId, existing);
  meeting.audioData.silenceTimers = currentTimers;
}

export function clearSnippetTimer(meeting: MeetingData, userId: string) {
  const currentTimers =
    meeting.audioData.silenceTimers || new Map<string, SnippetTimers>();
  const existing = currentTimers.get(userId);

  if (existing?.fast) {
    clearTimeout(existing.fast);
  }
  if (existing?.slow) {
    clearTimeout(existing.slow);
  }

  currentTimers.delete(userId);
  meeting.audioData.silenceTimers = currentTimers;
}

// Subscribe to a user's voice stream and handle the audio data
export async function subscribeToUserVoice(
  meeting: MeetingData,
  userId: string,
) {
  if (!isCaptureActive(meeting)) return;

  clearVoiceSubscription(meeting, userId);

  let createdOpusStream: Readable | undefined;
  let createdState: VoiceSubscriptionState | undefined;
  try {
    const opusStream = meeting.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });
    createdOpusStream = opusStream;

    const opusDecoder = new OpusDiagnosticDecoder(meeting.connection.receiver, {
      rate: RECORD_SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: FRAME_SIZE,
    });

    const subscriptions = getVoiceSubscriptions(meeting);
    const subscriptionState: VoiceSubscriptionState = {
      opusStream,
      decoder: opusDecoder,
      decodedStream: opusStream,
      ownedListenerCleanups: new Map(),
      decoderErrorCount: 0,
      consecutiveNoPcmEvents: 0,
    };

    subscriptions.set(userId, subscriptionState);
    createdState = subscriptionState;
    meeting.captureStartedAt ??= new Date();
    ensureRecordingCheckpointCapture(meeting);

    // Prevent decoder errors (often caused by malformed or partial packets) from crashing the process.
    const onDecoderError = (err: Error) => {
      if (subscriptionState.suppressResubscribe) return;
      if (isCaptureActive(meeting)) {
        meeting.audioData.captureIncomplete = true;
      }
      subscriptionState.decoderErrorCount += 1;
      console.warn(
        `Opus decoder error: meetingId=${meeting.meetingId} message=${err.message} errors=${subscriptionState.decoderErrorCount} ${opusDecoder.formatFailureDiagnostics()}`,
      );
      scheduleResubscribe(meeting, userId, "decoder-error");
    };
    opusDecoder.on("error", onDecoderError);
    subscriptionState.ownedListenerCleanups.set(opusDecoder, [
      () => opusDecoder.removeListener("error", onDecoderError),
    ]);

    // Prism's Opus stream can also emit errors; guard those too.
    const onOpusError = (err: Error) => {
      if (subscriptionState.suppressResubscribe) return;
      if (isCaptureActive(meeting)) {
        meeting.audioData.captureIncomplete = true;
      }
      console.warn(
        `Opus stream error: meetingId=${meeting.meetingId} message=${err.message}`,
      );
      scheduleResubscribe(meeting, userId, "opus-stream-error");
    };
    opusStream.on("error", onOpusError);
    const opusListenerCleanups = [
      () => opusStream.removeListener("error", onOpusError),
    ];
    subscriptionState.ownedListenerCleanups.set(
      opusStream,
      opusListenerCleanups,
    );

    const decodedStream = opusStream.pipe(opusDecoder);
    subscriptionState.decodedStream = decodedStream;

    const onDecodedError = (err: Error) => {
      if (subscriptionState.suppressResubscribe) return;
      if (isCaptureActive(meeting)) {
        meeting.audioData.captureIncomplete = true;
      }
      console.warn(
        `Decoded stream error: meetingId=${meeting.meetingId} message=${err.message}`,
      );
      scheduleResubscribe(meeting, userId, "decoded-stream-error");
    };
    decodedStream.on("error", onDecodedError);
    const decodedListenerCleanups =
      subscriptionState.ownedListenerCleanups.get(decodedStream) ?? [];
    decodedListenerCleanups.push(() =>
      decodedStream.removeListener("error", onDecodedError),
    );
    subscriptionState.ownedListenerCleanups.set(
      decodedStream,
      decodedListenerCleanups,
    );

    const onOpusClose = () => {
      if (subscriptionState.suppressResubscribe) return;
      scheduleResubscribe(meeting, userId, "opus-stream-close");
    };
    opusStream.on("close", onOpusClose);
    opusListenerCleanups.push(() =>
      opusStream.removeListener("close", onOpusClose),
    );

    const onOpusEnd = () => {
      if (subscriptionState.suppressResubscribe) return;
      scheduleResubscribe(meeting, userId, "opus-stream-end");
    };
    opusStream.on("end", onOpusEnd);
    opusListenerCleanups.push(() =>
      opusStream.removeListener("end", onOpusEnd),
    );

    const onPcmData = (chunk: Buffer) => {
      if (subscriptionState.suppressResubscribe) return;
      if (!isCaptureActive(meeting) || meeting.ownershipSignal?.aborted) return;
      let acceptedSpan: PcmSpan | undefined;
      if (
        meeting.recordingCapture &&
        !meeting.recordingCapture.push(
          `user:${userId}`,
          chunk,
          Date.now(),
          (span) => {
            acceptedSpan = span;
          },
        )
      )
        return;
      recordSpeechCapturedAudio({
        mode: meeting.runtimeConfig?.transcription.speechDetectionMode ?? "off",
        audioSeconds:
          chunk.length / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE),
      });
      subscriptionState.lastPcmAt = Date.now();
      subscriptionState.consecutiveNoPcmEvents = 0;
      subscriptionState.lastNoPcmAt = undefined;

      // Immediately write audio to the output stream to prevent memory buildup
      // This ensures audio is saved even for very long recordings
      if (meeting.audioData.audioPassThrough) {
        meeting.audioData.audioPassThrough.write(chunk, (err) => {
          if (err) {
            console.error(
              `Error writing audio chunk from user ${userId}:`,
              err,
            );
          }
        });
      }

      // Still maintain snippets for transcription purposes
      // These will be processed and cleared when user stops speaking or after 60 seconds
      const state = getSpeakerState(meeting, userId);
      updateSnippetsIfNecessary(meeting, userId, {
        startTimestamp: state?.lastStartMs,
      });

      const snippet = meeting.audioData.currentSnippets.get(userId);
      if (snippet) {
        if (acceptedSpan) {
          if (!snippet.chunks.length) snippet.pcmSpans = [];
          if (snippet.pcmSpans) appendPcmSpan(snippet.pcmSpans, acceptedSpan);
        } else snippet.pcmSpans = undefined;
        snippet.chunks.push(chunk);
        snippet.audioBytes = (snippet.audioBytes ?? 0) + chunk.length;
        maybeFinalizeSnippetsForInterjection(meeting, userId, snippet);
      }
    };
    decodedStream.on("data", onPcmData);
    decodedListenerCleanups.push(() =>
      decodedStream.removeListener("data", onPcmData),
    );
  } catch (error) {
    const current = getVoiceSubscriptions(meeting).get(userId);
    const ownsAttempt = createdState ? current === createdState : !current;
    if (ownsAttempt && isCaptureActive(meeting)) {
      meeting.audioData.captureIncomplete = true;
    }
    if (createdState) {
      clearVoiceSubscription(meeting, userId, createdState);
    } else if (createdOpusStream) {
      if (
        meeting.connection.receiver.subscriptions.get(userId) ===
        createdOpusStream
      ) {
        meeting.connection.receiver.subscriptions.delete(userId);
      }
      closeCaptureStream(meeting, createdOpusStream, () => {});
    }
    throw error;
  }
}

export function userStartTalking(meeting: MeetingData, userId: string) {
  if (isCaptureIntakeStopped(meeting)) return;
  markSpeakerStart(meeting, userId);
  clearSnippetTimer(meeting, userId);
}

export function userStopTalking(meeting: MeetingData, userId: string) {
  if (isCaptureIntakeStopped(meeting)) return;
  finishSpeakerTurn(meeting, userId);
}
function finishSpeakerTurn(meeting: MeetingData, userId: string) {
  markSpeakerEnd(meeting, userId);
  const pending = meeting.liveVoiceCommandPending;
  if (pending && pending.expiresAt > Date.now() && pending.userId === userId) {
    clearSnippetTimer(meeting, userId);
    startProcessingSnippet(meeting, userId, { forceTranscribe: true });
    return;
  }
  const snippet = meeting.audioData.currentSnippets.get(userId);
  if (!snippet) {
    const state = getSpeakerState(meeting, userId);
    const speakerLabel = resolveSpeakerLabel(meeting, userId);
    const durationMs =
      state?.lastStartMs && state.lastEndMs
        ? Math.max(0, state.lastEndMs - state.lastStartMs)
        : 0;
    if (durationMs >= NO_PCM_MIN_DURATION_MS && isCaptureActive(meeting)) {
      meeting.audioData.captureIncomplete = true;
    }
    const subscription = getVoiceSubscriptions(meeting).get(userId);
    const now = Date.now();
    const lastPcmAgoMs = subscription?.lastPcmAt
      ? Math.max(0, now - subscription.lastPcmAt)
      : undefined;
    if (subscription) {
      if (
        subscription.lastNoPcmAt &&
        now - subscription.lastNoPcmAt > NO_PCM_RESUBSCRIBE_WINDOW_MS
      ) {
        subscription.consecutiveNoPcmEvents = 0;
      }
      subscription.lastNoPcmAt = now;
      subscription.consecutiveNoPcmEvents += 1;
      if (
        durationMs >= NO_PCM_MIN_DURATION_MS &&
        subscription.consecutiveNoPcmEvents >= NO_PCM_RESUBSCRIBE_THRESHOLD
      ) {
        scheduleResubscribe(meeting, userId, "no-pcm");
        subscription.consecutiveNoPcmEvents = 0;
        subscription.lastNoPcmAt = undefined;
      }
    }
    console.log(
      `Speaking event ended with no PCM frames: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${userId} speaker=${speakerLabel} durationMs=${durationMs} lastPcmAgoMs=${lastPcmAgoMs ?? "unknown"}`,
    );
    return;
  }
  setSnippetTimer(meeting, userId);
}

export async function waitForFinishProcessing(meeting: MeetingData) {
  await Promise.all(
    meeting.audioData.audioFiles.map((fileData) => fileData.processingPromise),
  );
}

export async function waitForAudioOnlyFinishProcessing(meeting: MeetingData) {
  // Audio is now written in real-time, so this just ensures all metadata is updated
  // Keeping this function for compatibility but it essentially returns immediately
  await Promise.all(
    meeting.audioData.audioFiles.map(
      (fileData) => fileData.audioOnlyProcessingPromise || Promise.resolve(),
    ),
  );
}

function getAudioDuration(audio: AudioSnippet): number {
  return (
    getAudioBytes(audio) / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)
  );
}

type OutputCompletion = { kind: "closed" } | { kind: "failed"; error: Error };
const outputCompletions = new WeakMap<MeetingData, Promise<OutputCompletion>>();

export function openOutputFile(meeting: MeetingData) {
  const tempDir = ensureMeetingTempDirSync(meeting);
  const outputFileName = path.join(tempDir, "recording.mp3");
  meeting.audioData.outputFileName = outputFileName;

  meeting.audioData.audioPassThrough = new PassThrough();

  let complete: (result: OutputCompletion) => void = () => {};
  outputCompletions.set(
    meeting,
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  try {
    meeting.audioData.ffmpegProcess = ffmpeg(meeting.audioData.audioPassThrough)
      .inputOptions([
        "-f s16le", // PCM format
        `-ar ${RECORD_SAMPLE_RATE}`, // Sample rate
        `-ac ${CHANNELS}`, // Number of audio channels
      ])
      .audioCodec("libmp3lame") // Use LAME codec for MP3
      .outputOptions([
        `-b:a 128k`, // Bitrate for lossy compression
        `-ac ${CHANNELS}`, // Ensure stereo output
        `-ar ${RECORD_SAMPLE_RATE}`, // Ensure output sample rate
      ])
      .toFormat("mp3") // Output format as MP3
      .on("error", (err) => {
        complete({ kind: "failed", error: err });
        console.error("ffmpeg error:", err);
      })
      .on("end", () => complete({ kind: "closed" }));
    meeting.audioData.ffmpegProcess.save(outputFileName);
  } catch (error) {
    complete({ kind: "failed", error: error as Error });
    throw error;
  }
}

export function getMeetingOutputCompletion(meeting: MeetingData) {
  return outputCompletions.get(meeting);
}

function finishOutput(meeting: MeetingData): Promise<OutputCompletion> {
  // Terminal listeners were installed before save, including synchronous setup errors.
  const completion = outputCompletions.get(meeting);
  meeting.audioData.audioPassThrough?.end();
  if (completion) return completion;
  if (!meeting.audioData.ffmpegProcess)
    return Promise.resolve({ kind: "closed" });
  // An untracked encoder is not evidence that cleanup finished.
  return new Promise(() => {});
}

export async function closeOutputFile(meeting: MeetingData): Promise<void> {
  const result = await finishOutput(meeting);
  if (result.kind === "failed") throw result.error;
}

/** Partial startup cleanup is bounded; false retains owned work for later reconciliation. */
export async function closeFailedInitializationOutput(
  meeting: MeetingData,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finishOutput(meeting).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSpeakerTrackWrites(meeting: MeetingData) {
  const tracks = meeting.audioData.speakerTracks;
  if (!tracks || tracks.size === 0) return;
  const writes = Array.from(tracks.values())
    .map((track) => track.writePromise)
    .filter((promise): promise is Promise<void> => Boolean(promise));
  if (writes.length === 0) return;
  await Promise.all(writes);
}

export function buildMixedAudio(
  meeting: MeetingData,
): Promise<string | undefined> {
  return runMeetingProcessingEffect(meeting, () =>
    buildOwnedMixedAudio(meeting),
  );
}
async function buildOwnedMixedAudio(
  meeting: MeetingData,
): Promise<string | undefined> {
  const signal = getMeetingProcessingSignal(meeting);
  signal.throwIfAborted();
  const tracks = Array.from(meeting.audioData.speakerTracks?.values() ?? []);
  if (tracks.length === 0) return undefined;

  await ensureMeetingTempDir(meeting);
  signal.throwIfAborted();
  await waitForSpeakerTrackWrites(meeting);
  signal.throwIfAborted();

  const usable = tracks.filter((track) => {
    if (track.writeFailed) return false;
    if (!fs.existsSync(track.filePath)) return false;
    try {
      const stats = fs.statSync(track.filePath);
      return stats.size > 0;
    } catch {
      return false;
    }
  });
  if (usable.length === 0) return undefined;

  return renderMixedPcmTracks(
    usable,
    path.join(getMeetingTempDir(meeting), "recording_mixed.mp3"),
    signal,
  );
}

export async function cleanupSpeakerTracks(
  meeting: MeetingData,
): Promise<void> {
  const dir = meeting.audioData.speakerTrackDir;
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.error("Failed to clean up speaker track files:", error);
  }
}

export function unsubscribeToVoiceUponLeaving(
  meeting: MeetingData,
  userId: string,
) {
  clearVoiceSubscription(meeting, userId);
}

/** Called only after actual receiver attachment, never from reservation time. */
export function ensureRecordingCheckpointCapture(meeting: MeetingData): void {
  if (
    meeting.recordingCapture ||
    !meeting.captureStartedAt ||
    !meeting.reservation ||
    meeting.reservation.sessionMode !== "meeting" ||
    !meeting.ownershipSignal ||
    meeting.ownershipSignal.aborted
  )
    return;
  meeting.recordingCaptureState = {
    kind: "capturing",
    startedAt: meeting.captureStartedAt.toISOString(),
  };
  meeting.recordingCapture = createRecordingCheckpointCapture({
    directory: path.join(ensureMeetingTempDirSync(meeting), "checkpoints"),
    startedAt: meeting.captureStartedAt.getTime(),
    signal: meeting.ownershipSignal,
    commit: async (artifacts, signal) => {
      if (artifacts.some((artifact) => artifact.kind === "audio"))
        checkpointRecordingContext(meeting);
      return (
        (await appendMeetingCheckpointArtifacts(meeting, artifacts, signal))
          .kind === "committed"
      );
    },
    stopCapture: (reason) =>
      handleRecordingCaptureFailure(meeting, reason, () =>
        stopRecordingCapture(meeting, "interrupted"),
      ),
  });
  startRecordingContentCheckpoint(meeting);
}

/** Synchronous receiver detachment precedes messaging, storage and expensive finalization. */
export function stopRecordingCapture(
  meeting: MeetingData,
  disposition: "complete" | "interrupted" = "complete",
) {
  meeting.captureAudio = false;
  meeting.recordBotAudio = false;
  for (const id of getVoiceSubscriptions(meeting).keys())
    clearVoiceSubscription(meeting, id);
  meeting.ttsQueue?.stopAndClear();
  if (
    meeting.recordingCaptureState?.kind === "complete" ||
    meeting.recordingCaptureState?.kind === "interrupted"
  )
    return;
  const endedAt = new Date().toISOString();
  const startedAt = meeting.captureStartedAt?.toISOString() ?? null;
  meeting.recordingCaptureState =
    disposition === "complete" && startedAt
      ? { kind: "complete", startedAt, endedAt }
      : disposition === "complete"
        ? { kind: "not_started" }
        : { kind: "interrupted", startedAt, endedAt, detectedAt: endedAt };
}
