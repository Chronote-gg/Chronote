import ffmpeg from "fluent-ffmpeg";
import {
  RECORD_SAMPLE_RATE,
  TRANSCRIBE_SAMPLE_RATE,
  CHANNELS,
} from "../constants";

export function convertTranscriptionPcmToWav(
  inputFile: string,
  outputFile: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const command = ffmpeg(inputFile);
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    const cancel = () => command.kill("SIGTERM");
    signal?.addEventListener("abort", cancel, { once: true });
    command
      .on("start", () => {
        if (signal?.aborted) cancel();
      })
      .inputOptions([
        "-f s16le",
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ])
      .outputOptions([
        "-f wav",
        "-c:a pcm_s16le",
        `-ar ${TRANSCRIBE_SAMPLE_RATE}`,
      ])
      .on("end", () => {
        cleanup();
        resolve();
      })
      .on("error", (error) => {
        cleanup();
        reject(error);
      });
    try {
      command.save(outputFile);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
