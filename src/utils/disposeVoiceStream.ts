import type { Readable } from "node:stream";

const disposedStreams = new WeakSet<Readable>();

export function disposeVoiceStream(
  stream: Readable,
  detachOwnedListeners: () => void,
): void {
  if (disposedStreams.has(stream)) return;
  disposedStreams.add(stream);

  // destroy(error) emits asynchronously, even when destruction already started.
  // Keep this consumer on streams without close events; weak ownership lets them go.
  const consumeTeardownError = () => {};
  stream.on("error", consumeTeardownError);
  stream.once("close", () => {
    stream.removeListener("error", consumeTeardownError);
  });

  detachOwnedListeners();
  stream.unpipe();
  if (!stream.destroyed) stream.destroy();
}
