/** SDK cancellation can end the response wait while the submitted server effect continues. */
export function leaseDeleteResponse(
  actual: Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return actual;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void actual.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
