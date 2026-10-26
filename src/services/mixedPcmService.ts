import ffmpeg from "fluent-ffmpeg";
import { RECORD_SAMPLE_RATE, CHANNELS } from "../constants";
export function renderMixedPcmTracks(
  usable: readonly { filePath: string }[],
  outputFileName: string,
  signal: AbortSignal,
) {
  const command = ffmpeg();
  for (const track of usable)
    command
      .input(track.filePath)
      .inputOptions([
        "-f s16le",
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ]);
  const outputOptions = [
    `-b:a 128k`,
    `-ac ${CHANNELS}`,
    `-ar ${RECORD_SAMPLE_RATE}`,
  ];
  if (usable.length > 1) {
    const mixInputs = usable.map((_track, index) => `[${index}:a]`).join("");
    command.complexFilter(
      `${mixInputs}amix=inputs=${usable.length}:dropout_transition=0:normalize=0[mixed]`,
    );
    outputOptions.unshift("-map [mixed]");
  }
  command.audioCodec("libmp3lame").outputOptions(outputOptions).toFormat("mp3");
  return finishMixedAudioEncoder(command, outputFileName, signal);
}
function finishMixedAudioEncoder(
  command: ReturnType<typeof ffmpeg>,
  output: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => command.kill("SIGTERM");
    signal.addEventListener("abort", cancel, { once: true });
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (error) console.error("Failed to render mixed audio:", error);
      resolve(error ? undefined : output);
    };
    command
      .on("start", () => {
        if (signal.aborted) cancel();
      })
      .on("end", () => finish())
      .on("error", finish)
      .save(output);
  });
}
