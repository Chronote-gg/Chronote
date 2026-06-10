import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
} from "@discordjs/voice";
import ffmpeg from "fluent-ffmpeg";
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

function createOpusResource(pcmStream: Readable) {
  const opusEncoder = new prism.opus.Encoder({
    rate: OUTPUT_SAMPLE_RATE,
    channels: 2,
    frameSize: 960,
  });
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

async function playTtsItem(
  meeting: MeetingData,
  player: AudioPlayer,
  item: TtsQueueTtsItem,
  onPlaybackStart: () => void,
  onPlaybackEnd: () => void,
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
  const speechResponse = await openAIClient.audio.speech.create({
    model: modelChoice.model,
    voice: item.voice,
    input: item.text,
    response_format: "pcm",
  });

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
  const resampledPcm = command.pipe() as Readable;

  resampledPcm.on("data", (chunk: Buffer) => {
    if (
      meeting.recordBotAudio !== false &&
      meeting.audioData.audioPassThrough
    ) {
      meeting.audioData.audioPassThrough.write(chunk, (err) => {
        if (err) {
          console.error("Error writing TTS chunk to recording:", err);
        }
      });
    }
  });

  const resource = createOpusResource(resampledPcm);

  const start = Date.now();
  await waitForIdleIfPlaying(player);
  item.onBeforePlay?.(meeting);
  onPlaybackStart();
  player.play(resource);
  await waitForIdle(player);
  onPlaybackEnd();

  const entry: AudioFileData = {
    userId: item.userId,
    timestamp: start,
    transcript: item.text,
    processing: false,
    audioOnlyProcessing: false,
    source: item.source === "chat_tts" ? "chat_tts" : "bot",
    messageId: item.messageId,
  };
  meeting.audioData.audioFiles.push(entry);

  if (item.source === "chat_tts") {
    chatTtsSpoken.inc();
  }
}

async function playSfxItem(
  meeting: MeetingData,
  player: AudioPlayer,
  item: TtsQueueSfxItem,
  options: { waitForIdle?: boolean } = {},
): Promise<void> {
  const resampledPcm = ffmpeg(item.filePath)
    .audioFrequency(OUTPUT_SAMPLE_RATE)
    .audioChannels(2)
    .format("s16le")
    .on("error", (err) =>
      console.error(`ffmpeg cue pipeline error (${item.label}):`, err),
    )
    .pipe() as Readable;

  const resource = createOpusResource(resampledPcm);

  const start = Date.now();
  if (options.waitForIdle ?? true) {
    await waitForIdleIfPlaying(player);
  }
  player.play(resource);
  await waitForIdle(player);
  appendCueEvent(meeting, item, start);
}

export function createTtsQueue(
  meeting: MeetingData,
  player: AudioPlayer,
): TtsQueue {
  const queue: TtsQueueItem[] = [];
  let playing = false;
  let preparing = false;

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
          void playNext();
        }
      }
      return;
    }

    preparing = true;
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
      );
    } catch (error) {
      console.error("Failed to stream TTS to Discord:", error);
    } finally {
      preparing = false;
      if (queue.length > 0) {
        void playNext();
      }
    }
  };

  const enqueue = (item: TtsQueueItem) => {
    if (queue.length >= config.chatTts.queueLimit) {
      if (item.priority === "high") {
        queue.length = 0;
      } else {
        return false;
      }
    }
    queue.push(item);
    void playNext();
    return true;
  };

  const playCueIfIdle = (item: TtsQueueSfxItem) => {
    if (playing || queue.length > 0) return false;
    if (player.state.status !== AudioPlayerStatus.Idle) return false;

    playing = true;
    void (async () => {
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
          void playNext();
        }
      }
    })();

    return true;
  };

  const stopAndClear = () => {
    queue.length = 0;
    player.stop(true);
  };

  return {
    enqueue,
    playCueIfIdle,
    stopAndClear,
    size: () => queue.length,
  };
}
