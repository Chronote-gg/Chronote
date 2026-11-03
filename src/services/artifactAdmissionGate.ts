import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";

export function createArtifactAdmissionGate() {
  let sealed = false;
  let active = 0;
  const drained = new Set<() => void>();
  function ticket() {
    active++;
    let owned = true;
    return {
      beginOwned() {
        if (!owned) throw new Error("Artifact ownership already settled");
        return ticket();
      },
      settle() {
        if (!owned) return;
        owned = false;
        if (--active === 0) for (const notify of [...drained]) notify();
      },
    };
  }
  return {
    begin() {
      if (sealed)
        throw new RuntimeAdmissionUnavailable(
          "Artifact-producing admission is sealed",
        );
      return ticket();
    },
    seal(signal?: AbortSignal): Promise<void> {
      sealed = true;
      signal?.throwIfAborted();
      if (!active) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          drained.delete(done);
          signal?.removeEventListener("abort", cancelled);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const cancelled = () => {
          cleanup();
          reject(signal?.reason);
        };
        drained.add(done);
        signal?.addEventListener("abort", cancelled, { once: true });
      });
    },
    resume() {
      sealed = false;
    },
    get active() {
      return active;
    },
    get sealed() {
      return sealed;
    },
  };
}
export type ArtifactAdmissionGate = ReturnType<
  typeof createArtifactAdmissionGate
>;
