import type { PcmSpan } from "./types/transcriptCorrespondence";
import { appendPcmSpan } from "./utils/transcriptCorrespondence";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./services/meetingProcessingLifetime";
import { checkpointCompletedTranscription } from "./services/recordingContentService";
import { createCheckpointPlaybackTap } from "./services/recordingCheckpointPlayback";
import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
} from "@discordjs/voice";
import ffmpeg, { type FfmpegCommand } from "fluent-ffmpeg";
import prism from "prism-media";
import { Readable } from "node:stream";
import { ReadableStream as WebReadableStream } from "node:stream/web";
import type { MeetingData } from "./types/meeting-data";
import { config } from "./services/configService";
import { createOpenAIClient } from "./services/openaiClient";
import { buildModelOverrides, getModelChoice } from "./services/modelFactory";
import type {
  AudioCueEvent,
  AudioFileData,
  AudioSegmentSource,
} from "./types/audio";
import { chatTtsSpoken } from "./metrics";
import { ttsVolumePercentToMultiplier } from "./utils/ttsVolume";

export type TtsQueueSource = "live_voice" | "chat_tts";
export type TtsQueueTtsItem = {
  kind?: "tts";
  text: string;
  voice: string;
  userId: string;
  source: TtsQueueSource;
  messageId?: string;
  volumePercent?: number;
  priority?: "high" | "normal";
  onBeforePlay?: (meeting: MeetingData) => void;
};

export type TtsQueueSfxItem = {
  kind: "sfx";
  filePath: string;
  userId: string;
  label: string;
  transcriptText?: string;
  audioSource?: AudioSegmentSource;
  priority?: "high" | "normal";
};

export type TtsQueueItem = TtsQueueTtsItem | TtsQueueSfxItem;

export type TtsQueue = {
  enqueue: (item: TtsQueueItem) => boolean;
  playCueIfIdle: (item: TtsQueueSfxItem) => boolean;
  stopAndClear: () => void;
  size: () => number;
};

const OUTPUT_SAMPLE_RATE = 48000;
const TTS_ATTACK_SECONDS = 0.04;

const isSfxItem = (item: TtsQueueItem): item is TtsQueueSfxItem =>
  item.kind === "sfx";

function waitForIdle(player: AudioPlayer) {
  return new Promise<void>((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off("error", onError);
    };
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}

function waitForIdleIfPlaying(player: AudioPlayer) {
  if (player.state.status === AudioPlayerStatus.Idle) {
    return Promise.resolve();
  }
  return waitForIdle(player);
}

function createOpusResource(pcmStream: Readable, ownedStreams: Readable[]) {
  const opusEncoder = new prism.opus.Encoder({
    rate: OUTPUT_SAMPLE_RATE,
    channels: 2,
    frameSize: 960,
  });
  ownedStreams.push(opusEncoder);
  const opusStream = pcmStream.pipe(opusEncoder);
  return createAudioResource(opusStream, {
    inputType: StreamType.Opus,
  });
}

function appendCueEvent(
  meeting: MeetingData,
  item: TtsQueueSfxItem,
  timestamp: number,
) {
  if (!item.transcriptText) return;
  const entry: AudioCueEvent = {
    userId: item.userId,
    timestamp,
    text: item.transcriptText,
    source: item.audioSource ?? "bot",
  };
  if (!meeting.audioData.cueEvents) {
    meeting.audioData.cueEvents = [];
  }
  meeting.audioData.cueEvents.push(entry);
}

function observeEncoderTermination(command: FfmpegCommand): Promise<void> {
  return new Promise((resolve) => {
    command.on("end", () => resolve());
    command.on("error", () => resolve());
  });
}
async function closePlaybackStreams(streams: Readable[]): Promise<void> {
  const completion = streams.map(
    (stream) =>
      new Promise<void>((resolve) => {
        if (stream.closed) {
          resolve();
          return;
        }
        const ignoreError = () => {};
        stream.on("error", ignoreError);
        stream.once("close", () => {
          stream.removeListener("error", ignoreError);
          resolve();
        });
      }),
  );
  for (const stream of streams) stream.destroy();
  await Promise.all(completion);
}

async function playTtsItem(
  meeting: MeetingData,
  player: AudioPlayer,
  item: TtsQueueTtsItem,
  onPlaybackStart: () => void,
  onPlaybackEnd: () => void,
  isCurrent: () => boolean,
): Promise<void> {
  const modelChoice = getModelChoice(
    "liveVoiceTts",
    buildModelOverrides(meeting.runtimeConfig?.modelChoices),
  );
  const openAIClient = createOpenAIClient({
    traceName: "tts",
    generationName: "tts",
    userId: item.userId,
    sessionId: meeting.meetingId,
    tags: [`feature:${item.source}`],
    metadata: {
      guildId: meeting.guild.id,
      channelId: meeting.voiceChannel.id,
      voice: item.voice,
    },
  });
  const signal = getMeetingProcessingSignal(meeting);
  signal.throwIfAborted();
  const speechResponse = await openAIClient.audio.speech.create(
    {
      model: modelChoice.model,
      voice: item.voice,
      input: item.text,
      response_format: "pcm",
    },
    { signal },
  );

  if (!isCurrent()) {
    await speechResponse.body?.cancel();
    return;
  }
  if (!speechResponse.body) {
    console.warn("No audio body returned from TTS.");
    return;
  }

  const pcm24Stream = Readable.fromWeb(
    speechResponse.body as unknown as WebReadableStream<Uint8Array>,
  );

  const volumeMultiplier = ttsVolumePercentToMultiplier(item.volumePercent);
  const command = ffmpeg(pcm24Stream)
    .inputOptions(["-f s16le", "-ar 24000", "-ac 1"])
    .audioFrequency(OUTPUT_SAMPLE_RATE)
    .audioChannels(2)
    .format("s16le")
    .on("error", (err) => console.error("ffmpeg TTS pipeline error:", err));
  const audioFilters = [`afade=t=in:st=0:d=${TTS_ATTACK_SECONDS}`];
  if (volumeMultiplier !== 1) {
    audioFilters.push(`volume=${volumeMultiplier}`);
  }
  command.audioFilters(audioFilters);
  const encoderTermination = observeEncoderTermination(command);
  const resampledPcm = command.pipe() as Readable;

  const ownedStreams = [resampledPcm, pcm24Stream];
  let tap: ReturnType<typeof createCheckpointPlaybackTap> | undefined;
  const start = Date.now();
  let fullyPlayed: boolean;
  const consumedSpans: PcmSpan[] = [];
  let mappedPlayback = true;
  const playbackTextOnly = meeting.recordBotAudio === false;
  try {
    tap =
      meeting.recordBotAudio === false
        ? undefined
        : createCheckpointPlaybackTap({
            push: (chunk, observedAt) => {
              if (
                meeting.recordBotAudio === false ||
                meeting.ownershipSignal?.aborted
              )
                return false;
              let receivedSpan = false;
              if (
                meeting.recordingCapture &&
                !meeting.recordingCapture.push(
                  `bot:${item.userId}`,
                  chunk,
                  observedAt,
                  (span) => {
                    receivedSpan = true;
                    appendPcmSpan(consumedSpans, span);
                  },
                )
              )
                return false;
              if (chunk.length && !receivedSpan) mappedPlayback = false;
              meeting.audioData.audioPassThrough?.write(chunk, (error) => {
                if (error) meeting.audioData.captureIncomplete = true;
              });
              return true;
            },
            stop: () => {
              meeting.recordingCapture?.interrupt();
              player.stop(true);
            },
          });
    const resource = createOpusResource(
      tap ? resampledPcm.pipe(tap.stream) : resampledPcm,
      ownedStreams,
    );
    tap?.attach(resource);

    ownedStreams.push(resource.playStream);
    await waitForIdleIfPlaying(player);
    if (!isCurrent()) return;
    item.onBeforePlay?.(meeting);
    onPlaybackStart();
    player.play(resource);
    await waitForIdle(player);
    fullyPlayed = isCurrent() && (tap?.complete() ?? true);
  } finally {
    tap?.dispose();
    const streamsClosed = closePlaybackStreams(ownedStreams);
    command.kill("SIGTERM");
    onPlaybackEnd();
    await Promise.all([encoderTermination, streamsClosed]);
  }

  const entry: AudioFileData = {
    userId: item.userId,
    timestamp: start,
    transcript: fullyPlayed ? item.text : undefined,
    transcriptCorrespondence: !fullyPlayed
      ? undefined
      : playbackTextOnly
        ? { kind: "text_only" }
        : mappedPlayback
          ? { kind: "pcm", spans: consumedSpans }
          : undefined,
    processing: false,
    audioOnlyProcessing: false,
    source: item.source === "chat_tts" ? "chat_tts" : "bot",
    messageId: item.messageId,
  };
  meeting.audioData.audioFiles.push(entry);
  checkpointCompletedTranscription(meeting);

  if (item.source === "chat_tts") {
    chatTtsSpoken.inc();
    meeting.resetTtsOnlyIdleTimer?.();
  }
}

async function playSfxItem(
  meeting: MeetingData,
  player: AudioPlayer,
  item: TtsQueueSfxItem,
  options: { waitForIdle?: boolean } = {},
): Promise<void> {
  const command = ffmpeg(item.filePath)
    .audioFrequency(OUTPUT_SAMPLE_RATE)
    .audioChannels(2)
    .format("s16le")
    .on("error", (err) =>
      console.error(`ffmpeg cue pipeline error (${item.label}):`, err),
    );
  const encoderTermination = observeEncoderTermination(command);
  const resampledPcm = command.pipe() as Readable;

  const ownedStreams = [resampledPcm];
  const start = Date.now();
  try {
    const resource = createOpusResource(resampledPcm, ownedStreams);
    ownedStreams.push(resource.playStream);
    if (options.waitForIdle ?? true) await waitForIdleIfPlaying(player);
    getMeetingProcessingSignal(meeting).throwIfAborted();
    player.play(resource);
    await waitForIdle(player);
    getMeetingProcessingSignal(meeting).throwIfAborted();
    appendCueEvent(meeting, item, start);
  } finally {
    const streamsClosed = closePlaybackStreams(ownedStreams);
    command.kill("SIGTERM");
    await Promise.all([encoderTermination, streamsClosed]);
  }
}

export function createTtsQueue(
  meeting: MeetingData,
  player: AudioPlayer,
): TtsQueue {
  const queue: TtsQueueItem[] = [];
  let playing = false;
  let preparing = false;
  let generation = 0;

  const playNext = async () => {
    if (playing || preparing || queue.length === 0) return;
    const item = queue.shift();
    if (!item) return;

    if (isSfxItem(item)) {
      playing = true;
      try {
        await playSfxItem(meeting, player, item, { waitForIdle: true });
      } catch (error) {
        console.error("Failed to play audio cue:", error);
      } finally {
        playing = false;
        if (queue.length > 0) {
          void runMeetingProcessingEffect(meeting, playNext).catch(() => {});
        }
      }
      return;
    }

    preparing = true;
    const currentGeneration = generation;
    try {
      await playTtsItem(
        meeting,
        player,
        item,
        () => {
          playing = true;
        },
        () => {
          playing = false;
        },
        () =>
          generation === currentGeneration &&
          !getMeetingProcessingSignal(meeting).aborted,
      );
    } catch (error) {
      console.error("Failed to stream TTS to Discord:", error);
    } finally {
      preparing = false;
      if (queue.length > 0) {
        void runMeetingProcessingEffect(meeting, playNext).catch(() => {});
      }
    }
  };

  const enqueue = (item: TtsQueueItem) => {
    if (getMeetingProcessingSignal(meeting).aborted) return false;
    if (queue.length >= config.chatTts.queueLimit) {
      if (item.priority === "high") {
        queue.length = 0;
      } else {
        return false;
      }
    }
    queue.push(item);
    if (!isSfxItem(item) && item.source === "chat_tts") {
      meeting.resetTtsOnlyIdleTimer?.();
    }
    void runMeetingProcessingEffect(meeting, playNext).catch(() => {});
    return true;
  };

  const playCueIfIdle = (item: TtsQueueSfxItem) => {
    if (getMeetingProcessingSignal(meeting).aborted) return false;
    if (playing || queue.length > 0) return false;
    if (player.state.status !== AudioPlayerStatus.Idle) return false;

    playing = true;
    void runMeetingProcessingEffect(meeting, async () => {
      try {
        if (player.state.status !== AudioPlayerStatus.Idle) {
          return;
        }
        await playSfxItem(meeting, player, item, { waitForIdle: false });
      } catch (error) {
        console.error("Failed to play audio cue:", error);
      } finally {
        playing = false;
        if (!preparing && queue.length > 0) {
          void runMeetingProcessingEffect(meeting, playNext).catch(() => {});
        }
      }
    }).catch(() => {});

    return true;
  };

  const stopAndClear = () => {
    generation++;
    queue.length = 0;
    player.stop(true);
  };

  getMeetingProcessingSignal(meeting).addEventListener("abort", stopAndClear, {
    once: true,
  });

  return {
    enqueue,
    playCueIfIdle,
    stopAndClear,
    size: () => queue.length,
  };
}
