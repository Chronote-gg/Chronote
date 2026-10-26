import type { MeetingData } from "../types/meeting-data";
import type { Readable } from "node:stream";
import { disposeVoiceStream } from "../utils/disposeVoiceStream";

const captureStreamClosures = new WeakMap<MeetingData, Set<Promise<void>>>();
export async function waitForCaptureStreamSettlement(
  meeting: MeetingData,
): Promise<void> {
  const pending = captureStreamClosures.get(meeting);
  while (pending?.size) await Promise.all([...pending]);
}
export function closeCaptureStream(
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
