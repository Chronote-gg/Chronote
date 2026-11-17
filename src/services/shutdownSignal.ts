const shutdownController = new AbortController();

export function getShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

export function isShuttingDown(): boolean {
  return shutdownController.signal.aborted;
}

export function beginShutdown(reason?: unknown): void {
  // A second abort is a no-op, so the first reason is kept.
  shutdownController.abort(reason);
}

/** A distinct signal per operation that follows shutdown. Identity matters: notionOperationLifetime keys trackers by signal object. */
export function operationSignal(...extra: AbortSignal[]): AbortSignal {
  return AbortSignal.any([shutdownController.signal, ...extra]);
}
