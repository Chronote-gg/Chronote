import type { MeetingData } from "../types/meeting-data";

type Lifetime = {
  controller: AbortController;
  effects: Set<Promise<unknown>>;
  notices?: {
    original: MeetingData["reservation"];
    pending: number;
    known: boolean;
  };
};
const lifetimes = new WeakMap<object, Lifetime>();
function lifetime(meeting: object): Lifetime {
  let value = lifetimes.get(meeting);
  if (!value) {
    value = { controller: new AbortController(), effects: new Set() };
    lifetimes.set(meeting, value);
  }
  return value;
}
export function getMeetingProcessingSignal(
  meeting: Pick<MeetingData, "ownershipSignal" | "finalization">,
): AbortSignal {
  const signal = lifetime(meeting).controller.signal;
  return AbortSignal.any([
    signal,
    ...(meeting.ownershipSignal ? [meeting.ownershipSignal] : []),
    ...(meeting.finalization ? [meeting.finalization.controller.signal] : []),
  ]);
}
/** Register before invoking a provider or any reentrant callback. Include the complete effect chain. */
export function runMeetingProcessingEffect<T>(
  meeting: MeetingData,
  run: () => Promise<T>,
): Promise<T> {
  const owned = lifetime(meeting);
  const signal = getMeetingProcessingSignal(meeting);
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const effect = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  owned.effects.add(effect);
  void effect.then(
    () => owned.effects.delete(effect),
    () => owned.effects.delete(effect),
  );
  try {
    signal.throwIfAborted();
    resolve(run());
  } catch (error) {
    reject(error);
  }
  return effect;
}
/** Cancellation seals future dispatch; only actual completion removes an issued effect. */
export async function stopMeetingProcessing(
  meeting: MeetingData,
): Promise<void> {
  const owned = lifetime(meeting);
  owned.controller.abort(new Error("Meeting processing interrupted"));
  while (owned.effects.size) await Promise.allSettled([...owned.effects]);
}

/** Notice ACKs belong to this original owner. A later ACK never erases uncertainty. */
export function runMeetingNoticeMutation<T>(
  meeting: MeetingData,
  run: () => Promise<T>,
  definitelyRejected: (error: unknown) => boolean,
): Promise<T> {
  return runMeetingProcessingEffect(meeting, async () => {
    const owned = lifetime(meeting);
    const notices = (owned.notices ??= {
      original: meeting.reservation,
      pending: 0,
      known: true,
    });
    if (notices.original !== meeting.reservation)
      throw new Error("Meeting notice owner changed");
    notices.pending++;
    try {
      return await run();
    } catch (error) {
      if (!definitelyRejected(error)) {
        notices.known = false;
        owned.controller.abort(
          new Error("Meeting notice outcome is unknown", { cause: error }),
        );
      }
      throw error;
    } finally {
      notices.pending--;
    }
  });
}
export function areMeetingNoticesSettled(
  meeting: MeetingData,
  original: MeetingData["reservation"],
): boolean {
  const notices = lifetimes.get(meeting)?.notices;
  return (
    !notices ||
    (notices.original === original && notices.known && notices.pending === 0)
  );
}
