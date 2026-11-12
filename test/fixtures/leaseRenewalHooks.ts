/** Renewal hooks for a capture in progress that record what the lease service reports. */
export function inProgressRenewalHooks(maxDurationMs: number) {
  return {
    maxDurationMs,
    snapshot: () => ({ status: "in_progress" as const }),
    onEndRequested: jest.fn(),
    onLost: jest.fn(),
    onCapReached: jest.fn(),
  };
}
