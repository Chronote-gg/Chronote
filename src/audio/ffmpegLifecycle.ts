import type { FfmpegCommand } from "fluent-ffmpeg";

/** Abort requests termination; only the encoder terminal event settles the owned conversion. */
export function runFfmpegCommand(
  command: FfmpegCommand,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => command.kill("SIGTERM");
    const finish = (error?: Error) => {
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (signal?.aborted) reject(signal.reason);
      else resolve();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    command.on("start", () => {
      if (signal?.aborted) cancel();
    });
    command.on("end", () => finish());
    command.on("error", finish);
    command.run();
  });
}
