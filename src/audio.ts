import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  FAST_SILENCE_THRESHOLD,
  FRAME_SIZE,
  MAX_SNIPPET_LENGTH,
  MINIMUM_TRANSCRIPTION_LENGTH,
  NOISE_GATE_APPLY_TO_FAST,
  NOISE_GATE_APPLY_TO_SLOW,
  NOISE_GATE_ENABLED,
  NOISE_GATE_MIN_ACTIVE_WINDOWS,
  NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  NOISE_GATE_PEAK_DBFS,
  NOISE_GATE_WINDOW_MS,
  RECORD_SAMPLE_RATE,
  SILENCE_THRESHOLD,
  TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE,
} from "./constants";
import {
  AudioFileData,
  AudioSnippet,
  SpeakerState,
  SpeakerTrackFile,
} from "./types/audio";
import { MeetingData } from "./types/meeting-data";
import { EndBehaviorType, VoiceConnectionStatus } from "@discordjs/voice";
import prism from "prism-media";
import { PassThrough, Readable } from "node:stream";
import {
  cleanupTranscription,
  coalesceTranscription,
  transcribeSnippet,
} from "./services/transcriptionService";
import { buildModelOverrides, getModelChoice } from "./services/modelFactory";
import { formatParticipantLabel } from "./utils/participants";
import ffmpeg from "fluent-ffmpeg";
import { Client } from "discord.js";
import * as fs from "node:fs";
import path from "node:path";
import { maybeRespondLive } from "./liveVoice";
import { nowIso } from "./utils/time";
import {
  ensureMeetingTempDir,
  ensureMeetingTempDirSync,
  getMeetingTempDir,
} from "./services/tempFileService";
import { evaluateNoiseGate } from "./utils/audioNoiseGate";

const TRANSCRIPTION_HEADER =
  `NOTICE: Transcription is automatically generated and may not be perfectly accurate!\n` +
  `-----------------------------------------------------------------------------------\n`;

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

type OpusDecoder = InstanceType<typeof prism.opus.Decoder>;

type VoiceSubscriptionState = {
  opusStream: Readable;
  decoder: OpusDecoder;
  decodedStream: Readable;
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

function clearVoiceSubscription(meeting: MeetingData, userId: string) {
  const subscriptions = getVoiceSubscriptions(meeting);
  const existing = subscriptions.get(userId);
  if (existing?.resubscribeTimer) {
    clearTimeout(existing.resubscribeTimer);
  }
  if (existing) {
    existing.suppressResubscribe = true;
  }
  if (existing?.decodedStream) {
    existing.decodedStream.removeAllListeners();
  }
  if (existing?.decoder) {
    existing.decoder.removeAllListeners();
    existing.decoder.destroy();
  }
  if (existing?.opusStream) {
    existing.opusStream.removeAllListeners();
    existing.opusStream.destroy();
  }
  subscriptions.delete(userId);

  const receiverStream = meeting.connection.receiver.subscriptions.get(userId);
  if (receiverStream) {
    receiverStream.removeAllListeners();
    receiverStream.destroy();
    meeting.connection.receiver.subscriptions.delete(userId);
  }
}

function scheduleResubscribe(
  meeting: MeetingData,
  userId: string,
  reason: string,
) {
  if (meeting.finishing) return;
  if (meeting.connection.state.status === VoiceConnectionStatus.Destroyed) {
    return;
  }
  if (!meeting.voiceChannel.members.has(userId)) {
    return;
  }
  const subscriptions = getVoiceSubscriptions(meeting);
  const existing = subscriptions.get(userId);
  if (existing?.resubscribeTimer) {
    return;
  }

  const speakerLabel = resolveSpeakerLabel(meeting, userId);
  console.log(
    `Scheduling voice resubscribe: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${userId} speaker=${speakerLabel} reason=${reason}`,
  );

  const timer = setTimeout(() => {
    const updated = getVoiceSubscriptions(meeting).get(userId);
    if (updated) {
      updated.resubscribeTimer = undefined;
    }
    if (meeting.finishing) return;
    if (meeting.connection.state.status === VoiceConnectionStatus.Destroyed) {
      return;
    }
    void subscribeToUserVoice(meeting, userId);
  }, RESUBSCRIBE_DELAY_MS);

  if (existing) {
    existing.resubscribeTimer = timer;
  }
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

const DEFAULT_NOISE_GATE_CONFIG = {
  enabled: NOISE_GATE_ENABLED,
  windowMs: NOISE_GATE_WINDOW_MS,
  peakDbfs: NOISE_GATE_PEAK_DBFS,
  minActiveWindows: NOISE_GATE_MIN_ACTIVE_WINDOWS,
  minPeakAboveNoiseDb: NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  applyToFast: NOISE_GATE_APPLY_TO_FAST,
  applyToSlow: NOISE_GATE_APPLY_TO_SLOW,
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
  if (!noiseGate.enabled) return false;
  if (mode === "fast" && !noiseGate.applyToFast) return false;
  if (mode === "slow" && !noiseGate.applyToSlow) return false;
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
      track.lastEndMs = Math.max(track.lastEndMs, offsetMs + durationMs);
    } catch (error) {
      console.error(
        `Failed to persist speaker track for user ${snippet.userId}:`,
        error,
      );
      outputStream.destroy();
      track.writeFailed = true;
      track.writeFailureCount = (track.writeFailureCount ?? 0) + 1;
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
  void transcribeSnippet(meeting, snapshot, {
    tempSuffix: `fast-${revision}`,
    noiseGateMode: "fast",
  })
    .then((transcription) => {
      if (snippet.fastRevision !== revision) return;
      if (!transcription.trim() || transcription === "[Transcription failed]") {
        return;
      }
      const entry = {
        revision,
        text: transcription,
        createdAt: nowIso(),
      };
      if (!audioFileData.fastTranscripts) {
        audioFileData.fastTranscripts = [];
      }
      audioFileData.fastTranscripts.push(entry);
      audioFileData.transcript = transcription;
      snippet.fastTranscribed = true;
      snippet.lastFastTranscriptBytes = snapshotBytes;
      void maybeRespondLive(meeting, {
        userId: snippet.userId,
        text: transcription,
        timestamp: snippet.timestamp,
      });
    })
    .catch((error) => {
      console.error(
        `Failed to transcribe fast snippet for user ${snippet.userId}:`,
        error,
      );
    });
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

// Start processing a specific user's snippet
export function startProcessingSnippet(
  meeting: MeetingData,
  userId: string,
  options: SnippetProcessingOptions = {},
) {
  const snippet = meeting.audioData.currentSnippets.get(userId);
  if (!snippet) return;

  void persistSnippetSpeakerTrack(meeting, snippet);
  snippet.fastRevision = (snippet.fastRevision ?? 0) + 1;

  const audioFileData = getOrCreateAudioFileData(meeting, snippet);
  audioFileData.processing = true;

  const promises: Promise<void>[] = [];

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
  const fastCoversSnippet =
    fastFinalizationEnabled &&
    !options.forceTranscribe &&
    hasAudio &&
    Boolean(latestFastText) &&
    snippet.lastFastTranscriptBytes !== undefined &&
    getAudioBytes(snippet) === snippet.lastFastTranscriptBytes;
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
    audioFileData.transcript = latestFastText;
  } else if (
    hasAudio &&
    (duration > minSnippetSeconds || options.forceTranscribe)
  ) {
    if (
      options.forceTranscribe ||
      !shouldSkipByNoiseGate(meeting, snippet, "slow")
    ) {
      promises.push(
        transcribeSnippet(meeting, snippet, {
          noiseGateMode: "slow",
          noiseGateEnabledOverride: options.forceTranscribe ? false : undefined,
          suppressionEnabledOverride: options.forceTranscribe
            ? false
            : undefined,
        })
          .then(async (transcription) => {
            audioFileData.slowTranscript = transcription;
            audioFileData.transcript = transcription;
            if (!options.skipLiveVoice) {
              void maybeRespondLive(meeting, {
                userId: snippet.userId,
                text: transcription,
                timestamp: snippet.timestamp,
              });
            }

            const premium = meeting.runtimeConfig?.premiumTranscription;
            if (
              premium?.enabled &&
              transcription.trim().length > 0 &&
              audioFileData.fastTranscripts &&
              audioFileData.fastTranscripts.length > 0
            ) {
              try {
                const coalesced = await coalesceTranscription(meeting, {
                  slowTranscript: transcription,
                  fastTranscripts: audioFileData.fastTranscripts,
                });
                if (coalesced && coalesced.trim().length > 0) {
                  audioFileData.coalescedTranscript = coalesced;
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
      );
    }
  } else {
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

  audioFileData.processingPromise = Promise.all(promises).then(() => {
    audioFileData.processing = false;
  });

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
  if (meeting.finishing) return;
  if (meeting.connection.state.status === VoiceConnectionStatus.Destroyed) {
    return;
  }

  clearVoiceSubscription(meeting, userId);

  const opusStream = meeting.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.Manual,
    },
  });

  const opusDecoder = new prism.opus.Decoder({
    rate: RECORD_SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: FRAME_SIZE,
  });

  const subscriptions = getVoiceSubscriptions(meeting);
  const subscriptionState: VoiceSubscriptionState = {
    opusStream,
    decoder: opusDecoder,
    decodedStream: opusStream,
    decoderErrorCount: 0,
    consecutiveNoPcmEvents: 0,
  };

  subscriptions.set(userId, subscriptionState);

  const speakerLabel = resolveSpeakerLabel(meeting, userId);
  const logPrefix = `guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${userId} speaker=${speakerLabel}`;

  // Prevent decoder errors (often caused by malformed or partial packets) from crashing the process.
  opusDecoder.on("error", (err: Error) => {
    if (subscriptionState.suppressResubscribe) return;
    subscriptionState.decoderErrorCount += 1;
    console.warn(
      `Opus decoder error: ${logPrefix} message=${err.message} errors=${subscriptionState.decoderErrorCount}`,
    );
    scheduleResubscribe(meeting, userId, "decoder-error");
  });

  // Prism's Opus stream can also emit errors; guard those too.
  opusStream.on("error", (err: Error) => {
    if (subscriptionState.suppressResubscribe) return;
    console.warn(`Opus stream error: ${logPrefix} message=${err.message}`);
    scheduleResubscribe(meeting, userId, "opus-stream-error");
  });

  const decodedStream = opusStream.pipe(opusDecoder);
  subscriptionState.decodedStream = decodedStream;

  decodedStream.on("error", (err: Error) => {
    if (subscriptionState.suppressResubscribe) return;
    console.warn(`Decoded stream error: ${logPrefix} message=${err.message}`);
    scheduleResubscribe(meeting, userId, "decoded-stream-error");
  });

  opusStream.on("close", () => {
    if (subscriptionState.suppressResubscribe) return;
    scheduleResubscribe(meeting, userId, "opus-stream-close");
  });

  opusStream.on("end", () => {
    if (subscriptionState.suppressResubscribe) return;
    scheduleResubscribe(meeting, userId, "opus-stream-end");
  });

  decodedStream.on("data", (chunk) => {
    subscriptionState.lastPcmAt = Date.now();
    subscriptionState.consecutiveNoPcmEvents = 0;
    subscriptionState.lastNoPcmAt = undefined;

    // Immediately write audio to the output stream to prevent memory buildup
    // This ensures audio is saved even for very long recordings
    if (meeting.audioData.audioPassThrough) {
      meeting.audioData.audioPassThrough.write(chunk, (err) => {
        if (err) {
          console.error(`Error writing audio chunk from user ${userId}:`, err);
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
      snippet.chunks.push(chunk);
      snippet.audioBytes = (snippet.audioBytes ?? 0) + chunk.length;
      maybeFinalizeSnippetsForInterjection(meeting, userId, snippet);
    }
  });
}

export function userStartTalking(meeting: MeetingData, userId: string) {
  markSpeakerStart(meeting, userId);
  clearSnippetTimer(meeting, userId);
}

export function userStopTalking(meeting: MeetingData, userId: string) {
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

export async function compileTranscriptions(
  client: Client,
  meeting: MeetingData,
  options: { includeCues?: boolean } = {},
): Promise<string> {
  const resolveTranscriptText = (fileData: AudioFileData) => {
    if (fileData.finalPassTranscript !== undefined) {
      return fileData.finalPassTranscript;
    }
    if (fileData.coalescedTranscript) return fileData.coalescedTranscript;
    if (fileData.slowTranscript) return fileData.slowTranscript;
    if (fileData.transcript) return fileData.transcript;
    if (fileData.fastTranscripts && fileData.fastTranscripts.length > 0) {
      return fileData.fastTranscripts[fileData.fastTranscripts.length - 1].text;
    }
    return "";
  };

  const segments = meeting.audioData.audioFiles
    .map((fileData) => ({
      userId: fileData.userId,
      timestamp: fileData.timestamp,
      text: resolveTranscriptText(fileData),
    }))
    .filter((segment) => segment.text && segment.text.length > 0);

  if (options.includeCues && meeting.audioData.cueEvents) {
    for (const cue of meeting.audioData.cueEvents) {
      if (!cue.text) continue;
      segments.push({
        userId: cue.userId,
        timestamp: cue.timestamp,
        text: cue.text,
      });
    }
  }

  segments.sort((a, b) => a.timestamp - b.timestamp);

  const transcription = segments
    .map((segment) => {
      const participant = meeting.participants.get(segment.userId);
      const member = meeting.guild.members.cache.get(segment.userId);
      const user = client.users.cache.get(segment.userId);
      const fallbackName =
        member?.nickname ||
        member?.user.globalName ||
        member?.user.username ||
        user?.globalName ||
        user?.username ||
        segment.userId;
      const fallbackUsername =
        member?.user.username || user?.username || undefined;
      const speakerLabel = formatParticipantLabel(participant, {
        includeUsername: true,
        fallbackName,
        fallbackUsername,
      });

      return `[${speakerLabel} @ ${new Date(
        segment.timestamp,
      ).toLocaleString()}]: ${segment.text}`;
    })
    .join("\n");

  if (transcription.length === 0) {
    return transcription;
  }

  const premiumConfig = meeting.runtimeConfig?.premiumTranscription;
  if (!premiumConfig?.enabled || !premiumConfig.cleanupEnabled) {
    return TRANSCRIPTION_HEADER + transcription;
  }

  try {
    const cleanedUpTranscription = await cleanupTranscription(
      meeting,
      transcription,
    );

    const originalLines = transcription.split("\n").length;
    const cleanedLines = (cleanedUpTranscription || "").split("\n").length;
    console.log(
      `Transcription cleanup succeeded. Original lines: ${originalLines}, cleaned lines: ${cleanedLines}`,
    );

    if (
      cleanedLines <
      originalLines * TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE
    ) {
      console.error("Transcription cleanup failed checks, returning original.");
      return TRANSCRIPTION_HEADER + transcription;
    }

    return TRANSCRIPTION_HEADER + cleanedUpTranscription;
  } catch (error) {
    console.error("Transcription cleanup failed, returning original:", error);
    return TRANSCRIPTION_HEADER + transcription;
  }
}

export function openOutputFile(meeting: MeetingData) {
  const tempDir = ensureMeetingTempDirSync(meeting);
  const outputFileName = path.join(tempDir, "recording.mp3");
  meeting.audioData.outputFileName = outputFileName;

  meeting.audioData.audioPassThrough = new PassThrough();

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
      console.error("ffmpeg error:", err);
    })
    .save(outputFileName);
}

export function closeOutputFile(meeting: MeetingData): Promise<void> {
  return new Promise((resolve) => {
    if (meeting.audioData.audioPassThrough) {
      meeting.audioData.audioPassThrough.end(); // End the PassThrough stream
    }
    if (meeting.audioData.ffmpegProcess) {
      meeting.audioData.ffmpegProcess.on("end", () => {
        console.log(
          `Final MP3 file created as ${meeting.audioData.outputFileName}`,
        );
        resolve();
      });
    }
  });
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

export async function buildMixedAudio(
  meeting: MeetingData,
): Promise<string | undefined> {
  const tracks = Array.from(meeting.audioData.speakerTracks?.values() ?? []);
  if (tracks.length === 0) return undefined;

  await ensureMeetingTempDir(meeting);
  await waitForSpeakerTrackWrites(meeting);

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

  const outputFileName = path.join(
    getMeetingTempDir(meeting),
    "recording_mixed.mp3",
  );

  if (usable.length === 1) {
    return await new Promise<string | undefined>((resolve) => {
      ffmpeg(usable[0].filePath)
        .inputOptions([
          "-f s16le",
          `-ar ${RECORD_SAMPLE_RATE}`,
          `-ac ${CHANNELS}`,
        ])
        .audioCodec("libmp3lame")
        .outputOptions([
          `-b:a 128k`,
          `-ac ${CHANNELS}`,
          `-ar ${RECORD_SAMPLE_RATE}`,
        ])
        .toFormat("mp3")
        .on("error", (err) => {
          console.error("Failed to render single-speaker audio:", err);
          resolve(undefined);
        })
        .on("end", () => {
          resolve(outputFileName);
        })
        .save(outputFileName);
    });
  }

  return await new Promise<string | undefined>((resolve) => {
    const command = ffmpeg();

    usable.forEach((track) => {
      command
        .input(track.filePath)
        .inputOptions([
          "-f s16le",
          `-ar ${RECORD_SAMPLE_RATE}`,
          `-ac ${CHANNELS}`,
        ]);
    });

    const mixInputs = usable.map((_track, index) => `[${index}:a]`).join("");
    const filter = `${mixInputs}amix=inputs=${usable.length}:dropout_transition=0:normalize=0[mixed]`;

    command
      .complexFilter(filter)
      .outputOptions([
        "-map [mixed]",
        `-b:a 128k`,
        `-ac ${CHANNELS}`,
        `-ar ${RECORD_SAMPLE_RATE}`,
      ])
      .audioCodec("libmp3lame")
      .on("error", (err) => {
        console.error("Failed to render mixed audio:", err);
        resolve(undefined);
      })
      .on("end", () => {
        resolve(outputFileName);
      })
      .save(outputFileName);
  });
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
