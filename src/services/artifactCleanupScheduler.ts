import type { reconcileMeetingTempDirectory } from "./meetingArtifactCleanupService";
import type { CleanupReceiptResult } from "./artifactCleanupReceipt";

export type ArtifactCleanupStats = {
  pendingDirectories: number;
  blockedDirectories: number;
  pendingFiles: number;
  pendingBytes: number;
  oldestAgeSeconds: number;
};
type Obligation = {
  attempts: number;
  firstObservedAt: number;
  result: Exclude<CleanupReceiptResult, { kind: "cleaned" }>;
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
    let blockedDirectories = 0;
    for (const { result, firstObservedAt } of obligations.values()) {
      if (result.kind === "pending") {
        pendingFiles += result.remainingFiles;
        pendingBytes += result.remainingBytes;
      } else blockedDirectories++;
      oldestAgeSeconds = Math.max(
        oldestAgeSeconds,
        (Date.now() -
          (result.kind === "pending"
            ? Date.parse(result.createdAt)
            : firstObservedAt)) /
          1000,
      );
    }
    dependencies.observe({
      pendingDirectories: obligations.size,
      blockedDirectories,
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
        (entry) => entry.result.kind === "pending" && entry.attempts < 3,
      )
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      const next = Array.from(obligations.entries()).find(
        ([, entry]) => entry.result.kind === "pending" && entry.attempts < 3,
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
    else
      obligations.set(args[0], {
        attempts: previous?.attempts ?? 0,
        firstObservedAt: previous?.firstObservedAt ?? Date.now(),
        result,
      });
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
