import type { AudioSnippet, SpeakerTrackFile } from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
import { BYTES_PER_SAMPLE, CHANNELS, RECORD_SAMPLE_RATE } from "../constants";
import { finished } from "node:stream/promises";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./meetingProcessingLifetime";
import {
  ensureMeetingTempDir,
  ensureMeetingTempDirSync,
  getMeetingTempDir,
} from "./tempFileService";
import { renderMixedPcmTracks } from "./mixedPcmService";

function generateSilentBuffer(
  durationMs: number,
  sampleRate: number,
  channels: number,
): Buffer {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate) * channels;
  return Buffer.alloc(numSamples * BYTES_PER_SAMPLE);
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

export async function persistSnippetSpeakerTrack(
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
