import { Transform } from "node:stream";
import {
  reserveCheckpointPcm,
  releaseCheckpointPcm,
} from "./recordingCheckpointCapture";

type ConsumedResource = { playbackDuration: number; read(): Buffer | null };
/** PCM is retained only until the corresponding Opus packet is consumed by AudioResource.read. */
export function createCheckpointPlaybackTap(input: {
  push(bytes: Buffer, observedAt: number): boolean;
  stop(): void;
}) {
  const pending: Array<{ bytes: Buffer; offset: number }> = [];
  let retained = 0;
  let disposed = false;
  let restore: (() => void) | undefined;
  function dispose() {
    if (disposed) return;
    disposed = true;
    restore?.();
    releaseCheckpointPcm(retained);
    retained = 0;
    pending.length = 0;
    stream.destroy();
  }
  function fail() {
    dispose();
    input.stop();
  }
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (disposed) {
        callback();
        return;
      }
      if (
        retained + chunk.length > 48000 * 4 * 60 ||
        !reserveCheckpointPcm(chunk.length)
      ) {
        fail();
        callback();
        return;
      }
      retained += chunk.length;
      pending.push({ bytes: Buffer.from(chunk), offset: 0 });
      callback(null, chunk);
    },
  });
  function consume(length: number) {
    const available = pending.reduce(
      (sum, item) => sum + item.bytes.length - item.offset,
      0,
    );
    if (length > available || !reserveCheckpointPcm(length)) {
      fail();
      return;
    }
    const frame = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const item = pending[0];
      const count = Math.min(length - offset, item.bytes.length - item.offset);
      item.bytes.copy(frame, offset, item.offset, item.offset + count);
      item.offset += count;
      offset += count;
      if (item.offset === item.bytes.length) {
        pending.shift();
        retained -= item.bytes.length;
        releaseCheckpointPcm(item.bytes.length);
      }
    }
    const accepted = input.push(frame, Date.now());
    releaseCheckpointPcm(length);
    if (!accepted) fail();
  }
  function attach(resource: ConsumedResource) {
    const read = resource.read.bind(resource);
    resource.read = () => {
      const before = resource.playbackDuration;
      const packet = read();
      const consumedMs = resource.playbackDuration - before;
      if (!disposed && consumedMs > 0) consume(consumedMs * 192);
      return packet;
    };
    restore = () => {
      resource.read = read;
    };
  }
  return {
    stream,
    attach,
    dispose,
    complete: () => stream.writableFinished && pending.length === 0,
  };
}
