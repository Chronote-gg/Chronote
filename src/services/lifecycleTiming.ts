const MS_PER_SECOND = 1000;

/** Bounds every request to the ECS container agent and task metadata endpoint. */
export const RUNTIME_AGENT_TIMEOUT_MS = 5_000;

export const LIFECYCLE = {
  registryHeartbeatMs: 10_000,
  registryEligibleLogMs: 60_000,
  registryFreshSeconds: 30,
  registryItemTtlSeconds: 86_400,
  legacyHeartbeatStaleSeconds: 120,
  // Same value as ACTIVE_MEETING_LEASE_SECONDS so old and new lease writers agree.
  leaseSeconds: 30,
  leaseHeartbeatMs: 10_000,
  leaseTtlGraceSeconds: 120,
  // Added to the meeting duration cap so a full-length meeting can still close.
  leaseCapGraceMs: 15 * 60_000,
  startDeadlineMs: 30_000,
  // Pause before retrying a start transaction cancelled by a concurrent start.
  startConflictRetryMs: 200,
  // A recording's open audio piece is sealed and uploaded this long after its first audio.
  checkpointSegmentMs: 30_000,
  closeFlushMs: 60_000,
  // The flush bound for a close while shutting down, so the close fits the shutdown budget.
  shutdownFlushMs: 45_000,
  // A slow or rate-limited nickname call must not hold the server.
  closeNicknameMs: 5_000,
  // Bounds ending the audio encoder of a meeting no local finish loads.
  closeEncoderMs: 5_000,
  closeWriteAttempts: 3,
  finishClaimSeconds: 120,
  finishClaimRenewMs: 30_000,
  finishAttemptMaxMs: 45 * 60_000,
  // The failure after the last entry is final.
  finishBackoffSeconds: [60, 300, 900],
  // After the last entry, delivery retries hourly until it gives up.
  deliveryBackoffSeconds: [60, 300, 900],
  deliveryHourlySeconds: 3_600,
  deliveryGiveUpSeconds: 86_400,
  finisherScanMs: 60_000,
  // Kept below the scan interval, so a hung pass never outlives the next tick.
  finisherScanTimeoutMs: 45_000,
  finisherLeaseReadMs: 10_000,
  // The dead-man line the finisher scan alarm watches.
  finisherScanLogMs: 60_000,
  abandonedGraceSeconds: 120,
  stuckAlarmSeconds: 4 * 3_600,
  abandonSeconds: 86_400,
  maxConcurrentFinishes: 2,
  // How long shutdown waits for aborted finish attempts before releasing their claims anyway.
  finishAbortWaitMs: 5_000,
  protectionPastCapSeconds: 600,
  protectionRetryMs: 60_000,
  // ECS stops the task 120 seconds after SIGTERM, so this leaves 30 seconds of margin.
  shutdownBudgetMs: 90_000,
  // Caps each shutdown stage but capture closing, which gets what the capped stages leave (at least 65 s).
  shutdownStepMs: 3_000,
  // Kept back from the shutdown budget for the telemetry flush and the exit.
  shutdownReserveMs: 5_000,
  // Discord allows three seconds for a first response; the lease read and the receipt claim share them.
  interactionLeaseReadMs: 1_000,
  interactionReceiptClaimMs: 1_500,
  // Guild events have no response deadline; a claim cut short could lose the onboarding message for good.
  guildEventReceiptClaimMs: 30_000,
  localSweepMs: 3_600_000,
  localSweepAgeMs: 6 * 3_600_000,
  // Renewed by every poll of its holder, so it only lapses after the holder stops polling.
  renewalRecoveryLeaseSeconds: 600,
  // The SDK sets no deadline of its own, so one hung DynamoDB call would stall a heartbeat or hold a finish slot.
  dynamoConnectionTimeoutMs: 3_000,
  dynamoRequestTimeoutMs: 10_000,
  // An aborted finish attempt that does not unwind in this long is abandoned, so it cannot hold a finish slot.
  finishAbortGraceMs: 5_000,
} as const;

export function leaseCapEpochSeconds(
  reservedAtMs: number,
  maxDurationMs: number,
): number {
  return Math.floor(
    (reservedAtMs + maxDurationMs + LIFECYCLE.leaseCapGraceMs) / MS_PER_SECOND,
  );
}
