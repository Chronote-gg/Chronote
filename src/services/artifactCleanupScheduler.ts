import type { reconcileMeetingTempDirectory } from "./meetingArtifactCleanupService";
import type { CleanupReceiptResult } from "./artifactCleanupReceipt";

export type ArtifactCleanupStats = {
  pendingDirectories: number;
  pendingFiles: number;
  pendingBytes: number;
  oldestAgeSeconds: number;
};
type Obligation = {
  attempts: number;
  blocked: boolean;
  result: Extract<CleanupReceiptResult, { kind: "pending" }>;
};

export function createArtifactCleanupScheduler(dependencies: {
  reconcile: typeof reconcileMeetingTempDirectory;
  observe(stats: ArtifactCleanupStats): void;
}) {
  const obligations = new Map<string, Obligation>();
  let sealed = false;
  let tail = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function observe() {
    let pendingFiles = 0;
    let pendingBytes = 0;
    let oldestAgeSeconds = 0;
    for (const { result } of obligations.values()) {
      pendingFiles += result.remainingFiles;
      pendingBytes += result.remainingBytes;
      oldestAgeSeconds = Math.max(
        oldestAgeSeconds,
        (Date.now() - Date.parse(result.createdAt)) / 1000,
      );
    }
    dependencies.observe({
      pendingDirectories: obligations.size,
      pendingFiles,
      pendingBytes,
      oldestAgeSeconds,
    });
  }
  function arm() {
    if (
      sealed ||
      timer ||
      !Array.from(obligations.values()).some(
        (entry) => !entry.blocked && entry.attempts < 3,
      )
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      const next = Array.from(obligations.entries()).find(
        ([, entry]) => !entry.blocked && entry.attempts < 3,
      );
      if (!next) return;
      next[1].attempts++;
      void enqueue(next[0]).catch(() => {});
    }, 30_000);
    timer.unref();
  }
  async function perform(
    ...args: Parameters<typeof reconcileMeetingTempDirectory>
  ) {
    const result = await dependencies.reconcile(...args);
    const previous = obligations.get(args[0]);
    if (result.kind === "cleaned") obligations.delete(args[0]);
    else if (result.kind === "pending")
      obligations.set(args[0], {
        attempts: previous?.attempts ?? 0,
        blocked: false,
        result,
      });
    else if (previous) previous.blocked = true;
    observe();
    arm();
    return result;
  }
  function enqueue(...args: Parameters<typeof reconcileMeetingTempDirectory>) {
    if (sealed)
      return Promise.reject(new Error("Local artifact cleanup is sealed"));
    const result = tail.then(() => perform(...args));
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    enqueue,
    async seal() {
      sealed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await tail;
    },
    resume() {
      sealed = false;
      observe();
      arm();
    },
  };
}
