# Meeting Lifecycle Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Tick each task's line in the checklist below as it lands.

**Goal:** Replace the deployment coordinator, runtime lifecycle gates, durable voice ledger, cleanup receipts and separate recovery implementation with identical workers arbitrated by the per-server lease, one finish pipeline, and a plain ECS deployment.

**Architecture:** Every worker registers itself and decides in memory whether it is eligible to take new meetings (highest ready release). The per-server lease locks capture only; ending capture frees the server and hands the meeting to one idempotent finish pipeline with a normal loader and a recovery loader. Deployment is an ECS service update that waits only for an earlier deployment's live recording.

**Tech Stack:** Node.js 24, TypeScript, discord.js 14 and @discordjs/voice, AWS SDK v3 (DynamoDB, S3), ECS Fargate task protection through the agent endpoint, Jest with local DynamoDB for integration tests, GitHub Actions, Terraform.

**Spec:** `docs/superpowers/specs/2026-11-11-lifecycle-simplification-design.md`. The spec decides behaviour. This plan decides names, signatures, file ownership and order.

## Global Constraints

- No new MeetingHistory status values. DynamoDB data compatibility is required: existing rows, leases and checkpoints stay readable, and fields this change stops using are left in place.
- `executionVersion` is written as `1` and never changed. New rows carry `lifecycleVersion: 2`.
- Every duration comes from `LIFECYCLE` in `src/services/lifecycleTiming.ts`. No inline numbers.
- No em dashes in prose, comments or copy. Prefer type narrowing over `as`, `typeof` and `instanceof` hedging.
- Never put real server, user, channel or meeting identifiers or content in code, tests, docs, commits or PR text.
- Gates after every task: `yarn lint:check`, `yarn test`, `yarn build:all`, and the bot starts with `yarn dev`. Docker builds are not run locally.
- Coverage thresholds in `jest.config.ts` stay at or above 30/60/40/30 without editing that file.
- Stage D touches Stripe receipt and billing writes. Those edits remove one condition and change nothing else, and each gets a second reviewer.
- Parallel tasks run in separate git worktrees and never edit the same file. Section 3 says which tasks may run together.
- Each task follows the same cycle: write the tests the task names, run them and see them fail, implement to the signatures in section 1, run the gates, commit. A task is done when its named tests and the gates pass.
- Nothing in this plan deploys, applies Terraform, changes production records, or contacts a customer.

## Review Focus

Failure modes the spec implies that no scenario exercises, each pinned to the task that owns the code:

1. **End is requested twice, or by two causes at once** (button plus empty channel). Expected: one close, one set of notes. Test in B5: "concurrent closes share one promise and write the capture end once".
2. **Transcription or notes generation is switched off for the server.** Expected: the meeting reaches a terminal status and no empty notes are posted. Test in C4: "generation disabled saves a terminal status and posts no notes".
3. **A full-length meeting is finished by the recovery loader.** Expected: it completes inside one 45 minute attempt without holding all audio in memory. Test in C2: "recovery loader reads a 240 piece manifest with bounded concurrency".
4. **The gateway connection drops during capture**, which makes discord.js destroy the voice connection and makes the worker not ready. Expected: the meeting closes and its notes arrive once a worker is eligible again. Test in E3: "gateway drop during capture still delivers notes after reconnect".
5. **Clocks differ between workers.** Lease and claim conditions compare against the writer's clock. Expected: a worker fifteen seconds ahead cannot take a live lease or a live finish claim. Tests in B1 and C1: "a writer fifteen seconds ahead does not take a live lease" and "a writer fifteen seconds ahead does not take a live claim".

## Progress

- [x] A1 Lifecycle constants, shutdown signal, row types, metrics
- [x] A2 Extract history transitions
- [x] A3 Scenario harness
- [x] A4 Worker registry and eligibility
- [x] B1 Lease repository and service
- [x] B2 Task protection
- [x] B3 Voice session
- [x] B4 Start
- [x] B5 Close
- [x] C1 Finish repository
- [x] C2 Loaders
- [x] C3 Delivery
- [x] C4 Pipeline
- [x] C5 Finisher loop
- [x] D1 Interaction receipts and bot interaction path
- [x] D2 Personal uploads
- [x] D3 Billing and Stripe receipts
- [x] D4 API operations, Notion, notes correction
- [x] D5 Meeting update delivery worker and processing retry
- [x] D6 Control command queue
- [x] E1 Switch start, close and finish
  - Its removal half, split off as E1b during implementation, was folded into the deletion stage.
- [x] E2 Switch the worker lifecycle
  - Done as two tasks: E2a (worker entry, start-up, shutdown, eligibility gates, health latch, local sweep) and E2b (interaction routing, receipts, guild event claims).
- [x] E3 Worker-level scenarios
- [x] C6 Recovery cancellation check (added: the recovery loader runs the automatic auto-record cancellation check)
- [x] F1 Delete runtime, deployment control, lease and voice modules
  - Stage F was done as two deletion tasks, F-A (F1 and F3) and F-B (F2 and F4).
- [x] F2 Delete fixture mode and artifact tracking
- [x] F3 Delete operator publication and recovery modules
- [x] F4 Standalone test deletions
- [x] F-C Cleanup after the deletions (added: dead collector code, source-extraction tests replaced by behaviour tests)
- [x] G1 Deploy script
- [x] G2 Workflows and guard removal
- [x] G3 Terraform
- [x] G4 Docs
- [x] G5 Rollback and drain wait before the cutover (added: rollback changes nothing and the drain wait does not wait for the old runtime)
- [ ] G6 Bring the spec and the documents in line with what was built (added)
- [ ] Sandbox acceptance (spec, Testing section)

---

## 1. File map

### 1.1 Shared vocabulary (decided once)

| Thing                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lease handle              | Keep the existing name `SessionReservation` and the field `meeting.reservation`. It loses `workHandle` and nothing else. Checkpoint, content and history code keep reading `reservation.historyKey`, `ownerInstanceId`, `executionVersion`, `voiceOperationAttemptId` unchanged.                                                                                                                                                                                       |
| `executionVersion`        | Always `1`. Never bumped.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `voiceOperationAttemptId` | Still written on the lease (a random uuid per start). It is now only the capture attempt token that the checkpoint lease check compares. No voice record exists.                                                                                                                                                                                                                                                                                                       |
| Live capture lookup       | `meetings` map in `src/meetings.ts` stays keyed by guild and holds live captures only. A meeting leaves the map at close step 5.                                                                                                                                                                                                                                                                                                                                       |
| Abnormal end              | `capture.kind === "interrupted"` on the row (existing `RecordingCaptureState`). No new end reasons and no new status values. Abnormal causes (lost lease, capture error, shutdown, derived by finisher) write `endReason: "unknown"`. Architect's call.                                                                                                                                                                                                                |
| Delivery done marker      | The existing `recovery` value that today's normal completion writes (`recordingDeliveryService.ts:245`): `{disposition:"done", outcome:"completed", stage:"delivery", attempt:0, executionVersion:1, retry:{maxAttempts:3,nextAttemptAt:null}}`. Writing exactly this keeps `originalPublicationSettled` (`types/meetingPublication.ts:150`), notes correction, meeting update delivery and portal retry working with no change. No other `recovery` value is written. |
| Notes message marker      | Every notes embed and the summary embed carry `timestamp = history.timestamp` (the meeting start, which is the time half of the meeting key `channelId_timestamp`). Readback matches bot-authored messages in the notes channel whose first embed timestamp equals it. Architect's call, see risk R1 for why not footer or url.                                                                                                                                        |
| Time                      | Durations come from `LIFECYCLE` in `src/services/lifecycleTiming.ts`. Loops call `Date.now()`. Pure functions take `now`. Epoch seconds on the wire wherever the existing attribute is seconds.                                                                                                                                                                                                                                                                        |
| Alarm transport           | Fixed log lines matched by CloudWatch log metric filters (the repo's only working path, see `_infra/alerts-processing-retry.tf`). Prometheus counters are added too but nothing scrapes them.                                                                                                                                                                                                                                                                          |

### 1.2 Files created

#### `src/services/lifecycleTiming.ts`

Single responsibility: named durations. No logic.

```ts
export const LIFECYCLE = {
  registryHeartbeatMs: 10_000,
  registryFreshSeconds: 30,
  registryItemTtlSeconds: 86_400,
  legacyHeartbeatStaleSeconds: 120,
  leaseSeconds: 30, // existing ACTIVE_MEETING_LEASE_SECONDS
  leaseHeartbeatMs: 10_000,
  leaseTtlGraceSeconds: 120,
  leaseCapGraceMs: 15 * 60_000, // added to the meeting duration cap
  startDeadlineMs: 30_000,
  closeFlushMs: 60_000,
  closeWriteAttempts: 3,
  finishClaimSeconds: 120,
  finishClaimRenewMs: 30_000,
  finishAttemptMaxMs: 45 * 60_000,
  finishBackoffSeconds: [60, 300, 900], // 4th failure is final
  deliveryBackoffSeconds: [60, 300, 900], // then hourly
  deliveryHourlySeconds: 3_600,
  deliveryGiveUpSeconds: 86_400,
  finisherScanMs: 60_000,
  abandonedGraceSeconds: 120,
  stuckAlarmSeconds: 4 * 3_600,
  abandonSeconds: 86_400,
  maxConcurrentFinishes: 2, // architect's call
  protectionPastCapSeconds: 600,
  protectionRetryMs: 60_000,
  shutdownBudgetMs: 90_000,
  localSweepMs: 3_600_000,
  localSweepAgeMs: 6 * 3_600_000,
} as const;
export function leaseCapEpochSeconds(
  reservedAtMs: number,
  maxDurationMs: number,
): number;
```

#### `src/services/shutdownSignal.ts`

The one shutdown owner's signal. Replaces the work handle.

```ts
export function getShutdownSignal(): AbortSignal;
export function isShuttingDown(): boolean;
export function beginShutdown(reason?: unknown): void; // idempotent, aborts the signal
/** A distinct signal per operation that follows shutdown. Identity matters: notionOperationLifetime keys trackers by signal object. */
export function operationSignal(...extra: AbortSignal[]): AbortSignal; // AbortSignal.any([shutdown, ...extra])
```

#### `src/types/meetingHistoryTransition.ts`

Moved, not rewritten, from `src/types/deploymentControl.ts`: `HistoryKey`, `HISTORY_TRANSITION_FIELDS` (plus `"startMessageId"`, `"lifecycleVersion"` is NOT added, it is only written at start), `HistoryTransition`, `CheckpointPublication`, `TerminalCheckpointPreservation`, `InitialTerminalCheckpointDisposition`, `SessionOwnership`, `SessionReservation` (without `workHandle`), `validateHistoryTransition`, `ControlTableNames`. Dropped while moving: `recordingDelivery` proof, `completionPolicyProof` keeps, `fixture*` validation.

```ts
export type SessionReservation = {
  timingReceipt?: { reservedAt: number; monotonicMilliseconds: number };
  guildId: string;
  meetingId: string;
  ownerInstanceId: string;
  executionVersion: 1;
  voiceOperationAttemptId: string;
  reservedAt: number;
} & (
  | { sessionMode: "meeting"; historyKey: HistoryKey }
  | { sessionMode: "tts_only"; historyKey?: never }
);
export type SessionAdmissionResult =
  | { kind: "admitted"; reservation: SessionReservation }
  | { kind: "blocked"; reason: "active_session" | "suppressed" };
```

#### `src/repositories/meetingHistoryTransitions.ts`

Owns conditional writes on a MeetingHistory row made by the lease holder. Moved from `deploymentControlTransactions.ts` (`buildInitialMeetingHistoryPut` :766, `buildHistoryTransition` :796, `buildOwnedCheckpointTransition` :883) and the Dynamo and mock implementations in `deploymentControlRepository.ts` (:392, :905, :917, :973).

```ts
export function leaseOwnershipCheck(
  ownership: SessionOwnership,
  now: number,
  tables: ControlTableNames,
): TransactWriteItem;
// Same expression as today: meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version
// AND voiceOperationAttemptId = :attempt AND leaseExpiresAt >= :now AND sessionMode = :sessionMode
export function buildInitialMeetingHistoryPut(
  history: MeetingHistory,
  tables: ControlTableNames,
): PutItemCommandInput;
export function buildHistoryTransition(
  input: HistoryTransition,
  tables: ControlTableNames,
): UpdateItemCommandInput & { UpdateExpression: string };
export type MeetingHistoryTransitionRepository = {
  transitionMeetingHistory(
    input: HistoryTransition,
  ): Promise<"applied" | "stale">;
  getMeetingHistory(
    key: HistoryKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>; // ConsistentRead
};
export function getMeetingHistoryTransitionRepository(): MeetingHistoryTransitionRepository; // config.mock.enabled picks mockStore
```

`db.ts:225-228` keeps exporting `transitionMeetingHistory` from here so callers do not change. `createInitialMeetingHistory` has no caller after the switch and is deleted.

#### `src/repositories/workerRegistryRepository.ts`

Item IO for the registry partition of DeploymentControlTable (keys `pk`, `sk`, TTL attribute `expiresAt`, verified in `_infra/main.tf:2301`).

```ts
export const WORKERS_PK = "WORKERS";
export type WorkerRecord = {
  pk: "WORKERS";
  sk: `WORKER#${string}`;
  recordType: "worker";
  instanceId: string;
  release: number;
  ready: boolean;
  heartbeatAt: number; // epoch seconds
  captures: number;
  finishing: number;
  protectedUntil?: number; // epoch seconds
  taskArn?: string;
  expiresAt: number; // TTL: heartbeatAt + registryItemTtlSeconds
};
export type RegistryView = { workers: WorkerRecord[]; cutover: boolean };
export type WorkerRegistryRepository = {
  put(record: WorkerRecord): Promise<void>; // unconditional Put
  read(): Promise<RegistryView>; // Query pk = WORKERS, ConsistentRead
  writeCutover(instanceId: string, now: number): Promise<void>; // Put {pk:"WORKERS", sk:"CUTOVER", recordType:"cutover", cutoverAt, instanceId}, attribute_not_exists(pk); condition failure is success
  legacyHeartbeats(): Promise<number[]>; // Query pk = "ENV" AND begins_with(sk, "RUNTIME#"), ProjectionExpression heartbeatAt
};
export function getWorkerRegistryRepository(): WorkerRegistryRepository;
```

Old-protocol runtime record, exactly: pk `"ENV"`, sk `"RUNTIME#<instanceId>"`, attribute `heartbeatAt` in epoch seconds, written every 10 s (`RUNTIME_HEARTBEAT_MS`, `runtimeLifecycleService.ts:28`, schema `types/deploymentControl.ts:218`). `legacyHeartbeats` is the only read of old state and is deleted in the following release together with the standby branch.

#### `src/services/workerEligibility.ts`

Pure. The only place the eligibility rule and the first-deployment standby rule live.

```ts
export type EligibilityReason =
  | "eligible"
  | "not_ready"
  | "shutting_down"
  | "newer_release"
  | "legacy_standby";
export function resolveEligibility(input: {
  self: Pick<WorkerRecord, "instanceId" | "release" | "ready">;
  shuttingDown: boolean;
  view: RegistryView; // last successful read
  legacyHeartbeats: number[] | undefined; // undefined once cutover is known, then never queried
  now: number; // epoch seconds
}): { eligible: boolean; reason: EligibilityReason; writeCutover: boolean };
```

Rules: `newer_release` when another record has `ready`, `heartbeatAt > now - registryFreshSeconds` and a higher `release`. When `view.cutover` is false: `legacy_standby` while any legacy heartbeat is newer than `now - legacyHeartbeatStaleSeconds`; otherwise `writeCutover: true` and eligible on the same tick. An empty legacy list writes the marker immediately (fresh environments). Once `view.cutover` is true the legacy input is ignored.

#### `src/services/workerRegistry.ts`

Heartbeat loop and the in-memory answer.

```ts
export type WorkerLoad = {
  captures: number;
  finishing: number;
  protectedUntil?: number;
};
export function startWorkerRegistry(options: {
  mode: "all" | "bot" | "api";
  isGatewayReady(): boolean; // ignored when mode === "api"
  isServerListening(): boolean; // ignored when mode === "bot"
  load(): WorkerLoad;
}): Promise<void>; // resolves after the first write and first read
export function stopWorkerRegistry(): Promise<void>; // writes ready:false, clears the loop
export function isEligible(): boolean; // memory only
export function hasBeenReady(): boolean; // latches after the first successful ready:true write
export function onFirstEligible(listener: () => void): void;
export function getWorkerRelease(): number;
```

`ready` is recomputed on every heartbeat from the two probes plus "registry read at least once", so it is live: a lost gateway connection writes `ready: false` on the next tick. `hasBeenReady()` is the only latch. A failed read keeps the last view. Each tick writes `captures`, `finishing` and `protectedUntil` from `load()`. Logs `WORKER_ELIGIBLE_LOG` once a minute while eligible. A standby worker (legacy rule) is ready but never eligible, so it starts nothing and never asks for protection.

#### `src/repositories/meetingLeaseRepository.ts`

```ts
export type LeaseOwnership = Pick<
  SessionReservation,
  | "guildId"
  | "meetingId"
  | "ownerInstanceId"
  | "executionVersion"
  | "voiceOperationAttemptId"
  | "sessionMode"
>;
export type LeaseSnapshot = Pick<
  ActiveMeetingLease,
  | "status"
  | "endReason"
  | "endTriggeredByUserId"
  | "cancellationReason"
  | "endedAt"
>;
export type MeetingLeaseRepository = {
  /** One TransactWriteItems, ClientRequestToken = voiceOperationAttemptId. */
  startSession(input: {
    lease: ActiveMeetingLease;
    history?: MeetingHistory;
    suppression?: { channelId: string; expectedVersion?: number };
    now: number;
  }): Promise<"admitted" | "active_session" | "suppressed">;
  renew(
    ownership: LeaseOwnership,
    next: {
      leaseExpiresAt: number;
      expiresAt: number;
      updatedAt: string;
      snapshot: LeaseSnapshot;
    },
    now: number,
    signal?: AbortSignal,
  ): Promise<boolean>; // false = condition failed, throws = unknown
  retake(lease: ActiveMeetingLease, now: number): Promise<boolean>;
  release(ownership: LeaseOwnership): Promise<boolean>;
  read(
    guildId: string,
    signal?: AbortSignal,
  ): Promise<ActiveMeetingLease | undefined>; // ConsistentRead
};
export function getMeetingLeaseRepository(): MeetingLeaseRepository;
```

Conditions (lease key `guildId`):

- `startSession`: Put lease `attribute_not_exists(guildId) OR leaseExpiresAt < :now`; Put history `attribute_not_exists(guildId) AND attribute_not_exists(channelId_timestamp)`; ConditionCheck on `{pk:"SUPPRESS#<guild>", sk:"CHANNEL#<channel>"}` with the existing expression (`deploymentControlTransactions.ts:238-263`). Cancellation reason index 0 maps to `active_session`, the suppression item to `suppressed`.
- `renew`: `leaseExpiresAt >= :now AND meetingId = :m AND ownerInstanceId = :o AND executionVersion = :v AND sessionMode = :s` (today's expression, `db.ts:772`). Reuse `renewActiveMeetingLeaseWrite` for the transaction-conflict retry.
- `retake`: Put `attribute_not_exists(guildId) OR leaseExpiresAt < :now OR (meetingId = :m AND ownerInstanceId = :o)`.
- `release`: Delete `meetingId = :m AND ownerInstanceId = :o AND voiceOperationAttemptId = :a`.

`requestActiveMeetingEnd` and `getActiveMeetingLease` in `db.ts` stay as they are (portal and MCP path).

#### `src/services/meetingLease.ts`

What remains of `activeMeetingLeaseService.ts`, written fresh beside it.

```ts
export type AcquireSessionLeaseInput = Omit<
  AcquireMeetingLeaseInput,
  "scope" | "assertStartAllowed" | "startSignal" | "admissionContext"
>;
export function acquireSessionLease(
  input: AcquireSessionLeaseInput,
): Promise<SessionAdmissionResult>;
export function startLeaseRenewal(
  reservation: SessionReservation,
  hooks: {
    maxDurationMs: number;
    snapshot(): LeaseSnapshot;
    onEndRequested(lease: ActiveMeetingLease): void; // existing processRemoteEndRequest behaviour
    onLost(): void; // lease names another meeting
    onCapReached(): void; // no renewal past the cap, caller closes
  },
): void;
export function confirmSessionLease(
  reservation: SessionReservation,
): Promise<"held" | "lost">; // conditional renewal; condition failure reads and retakes; error throws
export function releaseSessionLease(
  reservation: SessionReservation,
): Promise<void>; // stops renewal, conditional delete, never throws on condition failure
export function latestLeaseCap(now: number): number | undefined; // max cap over reservations whose last confirmed leaseExpiresAt >= now
// Kept as is, moved from activeMeetingLeaseService: getActiveMeetingLeaseForGuild, isLeaseActive, requestMeetingEndViaLease, getCurrentMeetingLeaseOwnerInstanceId
```

Renewal tick: `leaseExpiresAt = min(now + leaseSeconds, cap)`. Error: log, count, keep recording, try again next tick. Condition failure: `read`; absent or expired: `retake` and carry on; another meeting: `onLost()` once and stop. The caller wires `onLost` and `onCapReached` to `closeMeeting(meeting, { endReason: "unknown", abnormal: true })`, whose step 1 then takes the lost-lease path or the normal path.

#### `src/services/taskProtection.ts`

Captures only. Reuses the request and response parsing of `runtimeProtectionService.ts` (`requestState`, `protectionResponse`).

```ts
export function createTaskProtection(deps: {
  agentUri: string;
  request?: typeof fetch;
  now?: () => number;
  latestLeaseCap(now: number): number | undefined;
}): {
  ensure(signal?: AbortSignal): Promise<boolean>; // PUT ProtectionEnabled true, ExpiresInMinutes = ceil((cap + protectionPastCapSeconds - now) / 60). No-op and false when latestLeaseCap is undefined.
  clear(): Promise<void>; // retried every protectionRetryMs until it succeeds
  protectedUntil(): number | undefined;
};
export function requestCaptureProtection(): Promise<void>; // singleton; called before joining voice; starts the once-a-minute retry while not covered
export function releaseCaptureProtection(): void; // called when the last capture closes
export function getProtectedUntil(): number | undefined;
```

A refused or failed call logs `TASK_PROTECTION_FAILED_LOG`, increments the counter, and never throws to the caller. Outside ECS (`config.runtime.agentUri` empty) all calls are no-ops.

#### `src/services/voiceSession.ts`

Replaces `guildVoiceOperationService.ts` and the custom gateway strategy.

```ts
export function joinVoice(options: {
  voiceChannel: VoiceBasedChannel;
  guild: Guild;
  captureAudio: boolean;
  signal: AbortSignal;
}): Promise<VoiceConnection>; // joinVoiceChannel + entersState(Ready), selfDeaf = !captureAudio
export function leaveVoice(connection: VoiceConnection): void; // connection.destroy()
export function dropVoiceLocally(connection: VoiceConnection): void; // connection.destroy(false): no voice state update is sent
```

#### `src/services/meetingStart.ts`

```ts
export function startMeetingSession(
  options: MeetingInitOptions,
): Promise<MeetingData>;
```

Order: `acquireSessionLease` (history row carries `lifecycleVersion: 2`, `executionVersion: 1`, `ownerInstanceId`, `status: "starting"`), `requestCaptureProtection()` (meeting mode only), `joinVoice`, build `MeetingData` through the existing body of `initializeReservedMeeting` (extracted in `meetings.ts` as `buildMeetingSession`, see 1.3), `startLeaseRenewal`, transition `starting` to `in_progress`. One `AbortSignal.timeout(LIFECYCLE.startDeadlineMs)` covers everything up to the first subscription. On any failure: `dropVoiceLocally` or `leaveVoice`, mark the row `failed` (condition `status IN (starting, in_progress)`), `releaseSessionLease`, rethrow so the caller tells the requester. `MeetingInitOptions` loses `scope`, `assertStartAllowed`, `leaseOwnerInstanceId`.

#### `src/services/meetingClose.ts`

```ts
export type CloseCause = {
  endReason: MeetingEndReason;
  endTriggeredByUserId?: string;
  abnormal?: boolean;
};
/** Same promise for every caller of the same meeting. */
export function closeMeeting(
  meeting: MeetingData,
  cause: CloseCause,
): Promise<void>;
export function closeAllCaptures(cause: CloseCause): Promise<void>; // shutdown
```

Steps as in the spec. Step 1 `confirmSessionLease`; `"lost"` switches to the lost-lease path (`dropVoiceLocally`, flush, step 4 with `capture.kind = "interrupted"` and no claim, drop). Step 4 calls `recordCaptureEnd` up to `closeWriteAttempts` times. The finish claim is included only when `isEligible() && !isShuttingDown()`. Step 5 in `finally`: `releaseSessionLease`, `deleteMeeting(meeting)`, `releaseCaptureProtection()` when no capture remains. When the claim was written, close ends by calling `void runLocalFinish(meeting)` (in `meetingFinisher.ts`); it never awaits it. `tts_only` sessions run steps 1, 2 and 5 only (architect's call: TTS-only keeps holding the lease, has no row, asks for no protection).

#### `src/repositories/meetingFinishRepository.ts`

```ts
export type FinishState = {
  owner?: string;
  expiresAt?: number; // epoch seconds, present while claimed
  attempts: number; // failed attempts in the current phase
  nextAttemptAt?: number; // epoch seconds
  startedAt?: number; // epoch seconds, start of the current attempt
  phase: "process" | "deliver";
  deliverSince?: number; // epoch seconds, first delivery failure
};
export type FinisherRow = Pick<
  MeetingHistory,
  | "guildId"
  | "channelId_timestamp"
  | "meetingId"
  | "status"
  | "timestamp"
  | "updatedAt"
  | "lifecycleVersion"
  | "finish"
  | "ownerInstanceId"
>;
export type FinishClaim = {
  key: HistoryKey;
  meetingId: string;
  owner: string;
  history: MeetingHistory;
};
export type MeetingFinishRepository = {
  scan(signal: AbortSignal): AsyncIterable<FinisherRow>;
  recordCaptureEnd(input: {
    reservation: SessionReservation;
    patch: Pick<
      MeetingHistory,
      "capture" | "endReason" | "endTriggeredByUserId" | "duration"
    >;
    claimOwner?: string;
    now: number;
  }): Promise<boolean>;
  claim(
    row: FinisherRow,
    owner: string,
    now: number,
    options?: { operator?: boolean },
  ): Promise<FinishClaim | undefined>;
  adopt(
    row: FinisherRow,
    owner: string,
    derived: Pick<MeetingHistory, "capture" | "endReason" | "duration">,
    now: number,
  ): Promise<FinishClaim | undefined>;
  renew(claim: FinishClaim, now: number): Promise<boolean>;
  save(
    claim: FinishClaim,
    patch: Partial<MeetingHistory>,
    now: number,
    expectedStatus?: MeetingStatus,
  ): Promise<MeetingHistory | undefined>;
  releaseDone(claim: FinishClaim): Promise<void>; // REMOVE finish
  releaseForRetry(
    claim: FinishClaim,
    next: Pick<
      FinishState,
      "attempts" | "nextAttemptAt" | "phase" | "deliverSince"
    >,
  ): Promise<void>;
  releaseUnclaimed(claim: FinishClaim): Promise<void>; // shutdown: keep counters, drop owner and expiresAt
  abandon(row: FinisherRow, now: number): Promise<boolean>; // 24 hour rule
  listStranded(signal: AbortSignal): AsyncIterable<MeetingHistory>; // operator: non-terminal AND attribute_not_exists(lifecycleVersion)
};
export function getMeetingFinishRepository(): MeetingFinishRepository;
```

Condition expressions (`#o` = `owner`, a reserved word; `finish` is always SET as a whole map computed from the row just read):

- `scan`: Scan, ConsistentRead, FilterExpression `lifecycleVersion = :two AND (#status IN (:starting, :in_progress, :processing) OR attribute_exists(finish))`, projection = `FinisherRow`. Comment `// ponytail: full table scan each minute, add a sparse GSI on open meetings when the table grows`.
- `recordCaptureEnd`: Update `meetingId = :m AND ownerInstanceId = :o AND #status IN (:starting, :in_progress)`; SET `status = processing`, the patch, `updatedAt`, and `finish = {owner, expiresAt: now + finishClaimSeconds, attempts: 0, startedAt: now, phase: "process"}` only when `claimOwner` is given.
- `claim`: Update `meetingId = :m AND lifecycleVersion = :two AND (attribute_not_exists(finish.#o) OR finish.expiresAt < :now) AND (attribute_not_exists(finish.nextAttemptAt) OR finish.nextAttemptAt <= :now)`, ReturnValues ALL_NEW. `operator: true` replaces the `lifecycleVersion` term with `attribute_not_exists(lifecycleVersion)`.
- `adopt`: TransactWriteItems. ConditionCheck on the lease `attribute_not_exists(guildId) OR meetingId <> :m OR leaseExpiresAt < :now`; Update history `meetingId = :m AND lifecycleVersion = :two AND #status IN (:starting, :in_progress) AND attribute_not_exists(finish.#o)`, SET `status = processing`, derived fields, `finish`.
- `renew` and `save`: `meetingId = :m AND finish.#o = :me AND finish.expiresAt >= :now` (plus `#status = :expected` when given). `renew` SETs `finish.expiresAt`. The caller refuses to renew once `now - startedAt > finishAttemptMaxMs`.
- `releaseDone`, `releaseForRetry`, `releaseUnclaimed`: `finish.#o = :me`; a condition failure is ignored.
- `abandon`: `meetingId = :m AND #status IN (:starting, :in_progress, :processing)`, SET `status = failed`, REMOVE `finish`.

#### `src/services/meetingFinishInput.ts`

```ts
export type FinishInput = {
  source: "normal" | "recovery";
  notesInput: MeetingNotesInput; // existing type, types/meeting-data.ts:172
  transcript: string; // "" when nothing usable or transcription is off
  transcriptUpload?: { key: string; body: Buffer }; // absent when history.transcriptS3Key is already recorded
  processing: MeetingProcessingOutcome; // transcription outcome known to the loader
  participants: Participant[];
  hasSavedAudio: boolean;
  cancel?: { reason?: string }; // completion policy or auto-record evaluation says cancel
  recordingPath?: string;
  chatLogPath?: string; // normal loader only
  localDirectory?: string; // deleted at step 7
};
export function loadNormalFinishInput(
  meeting: MeetingData,
  client: Client,
  signal: AbortSignal,
): Promise<FinishInput>;
export function loadRecoveryFinishInput(
  history: MeetingHistory,
  signal: AbortSignal,
): Promise<FinishInput>;
```

`loadNormalFinishInput` is today's `finalizeRecording` body from "wait-audio-only" to "compile-transcriptions-upload" (`endMeeting.ts:455-646`) minus notes generation, uploads and Discord, and it builds `notesInput` with `liveMeetingNotesInput(meeting)`. `loadRecoveryFinishInput` composes `readRecoveryContent`, `recoverTranscript`, `processRecoveryTranscript`, `recoveryNotesInput` and the mix render from `recoveryTranscriptionProcessing.ts` (`writeVerifiedTracks`). No manifest or no verified audio gives `hasSavedAudio: false`.

#### `src/services/meetingDelivery.ts`

Renders from the saved row and posts over REST. No discord.js client.

```ts
export type RestMessage = {
  embeds: Record<string, unknown>[];
  components?: Record<string, unknown>[];
  content?: string;
  allowed_mentions: { parse: [] };
};
export function renderMeetingDelivery(
  history: MeetingHistory,
  extras?: { upgrade?: SummaryUpgradeOffer },
): { summary: RestMessage; notes: RestMessage[] }; // pure
export function countPostedNotes(
  messages: DiscordEditorMessage[],
  history: MeetingHistory,
  botId: string,
): number; // pure: leading chunks already present
export function classifyDeliveryError(
  error: unknown,
): "temporary" | "permanent"; // permanent: DiscordMessageHttpError status 403, or 404 on a channel route
export type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "temporary"; error: unknown }
  | { kind: "permanent"; error: unknown }
  | { kind: "not_applicable" };
export function deliverMeeting(input: {
  history: MeetingHistory;
  save(
    patch: Pick<
      MeetingHistory,
      | "summaryMessageId"
      | "notesMessageIds"
      | "notesChannelId"
      | "delivery"
      | "notesDeliveryTiming"
      | "recovery"
    >,
  ): Promise<MeetingHistory | undefined>;
  transport?: DeliveryTransport;
  signal: AbortSignal;
}): Promise<DeliveryOutcome>;
export function deliverNotice(
  history: MeetingHistory,
  text: string,
  signal: AbortSignal,
): Promise<void>; // no-speech and failed notices, edits the start message when recorded, else posts
```

Algorithm: channel = `history.textChannelId`. (1) Summary: PATCH `history.startMessageId ?? history.summaryMessageId`; 404 on the message posts a new one; save `summaryMessageId` and `delivery.summary`. (2) Readback: GET `/channels/{id}/messages?after=<summaryMessageId>&limit=100`, `countPostedNotes`; adopt found ids in order into `notesMessageIds`. (3) POST the remaining chunks one at a time, saving `notesMessageIds` (appended) and `notesChannelId` after each acknowledgment. (4) Final save writes `delivery.notes` complete and the delivery done marker (1.1). The payload shape equals today's `embed.ts` output so meeting update delivery keeps recognising it.

#### `src/services/meetingFinish.ts`

```ts
export function finishMeeting(
  claim: FinishClaim,
  load: (signal: AbortSignal) => Promise<FinishInput>,
  options?: { deliver?: boolean },
): Promise<void>;
export function nextFinishRetry(
  attempts: number,
  now: number,
): number | undefined; // undefined = give up
export function nextDeliveryRetry(
  state: Pick<FinishState, "attempts" | "deliverSince">,
  now: number,
): number | undefined;
```

Pipeline, each step skipped when the row already records its output: (1) upload transcript, save `transcriptS3Key`; (2) `ensureMeetingNotes(input.notesInput)`, `ensureMeetingSummaries`, `stripUnknownMentions` as today; (3) one `save(..., expectedStatus "processing")` with notes, summary fields, `processing`, `participants`, `tags`, notes version fields and the terminal status (`cancelled` when `input.cancel`, else `complete` or `interrupted` from `history.capture.kind`), setting `finish.phase = "deliver"`; (4) `deliverMeeting`; (5) upload recording and chat log through `uploadMeetingArtifacts` semantics, best effort; (6) follow-ons: `maybeAutoExportCompletedMeeting`, user index, analytics, minutes-limit notice; (7) `releaseDone`, delete `localDirectory`. A renewal timer (`finishClaimRenewMs`) runs for the whole call and aborts the attempt signal when `renew` returns false or the 45 minute cap passes. Outcomes: no audio gives `failed` with no notice; empty transcript gives the existing `EMPTY_RECORDING_NOTICE` and `complete` or `interrupted`; steps 1 to 3 throwing gives `releaseForRetry` or, on the fourth failure, `failed` plus one `deliverNotice` (best effort, once) plus `MEETING_FINISH_FAILED_LOG`; delivery temporary gives `releaseForRetry` in phase `deliver`; delivery permanent, or temporary past `deliveryGiveUpSeconds`, writes `delivery.notes.outcome = "failed"`, `releaseDone`, and logs `MEETING_DELIVERY_FAILED_LOG` only for the temporary case.

#### `src/services/meetingFinisher.ts`

```ts
export type FinisherAction = "skip" | "adopt" | "claim" | "abandon";
export function classifyFinisherRow(
  row: FinisherRow,
  lease: ActiveMeetingLease | undefined,
  now: number,
): FinisherAction; // pure
export function runFinisherScan(signal: AbortSignal): Promise<void>;
export function startMeetingFinisher(): void; // setInterval(finisherScanMs), each tick returns unless isEligible()
export function stopMeetingFinisher(): Promise<void>;
export function runLocalFinish(meeting: MeetingData): Promise<void>; // normal loader on the closing worker
export function releaseLocalFinishClaims(): Promise<void>; // shutdown
export function activeFinishCount(): number;
```

`classifyFinisherRow`: `abandon` when non-terminal and `now - timestamp > abandonSeconds`; `skip` when an unexpired lease names the same meeting, when `finish.owner` is set and `finish.expiresAt >= now`, or when `finish.nextAttemptAt > now`; for `starting` and `in_progress` with no such lease, `adopt` only when `now - (updatedAt ?? timestamp) > abandonedGraceSeconds`; otherwise `claim`. Adopt derives end time and duration from the checkpoint manifest (`captureCoverage.lastConfirmedCaptureAt`, else zero duration). Rows non-terminal for more than `stuckAlarmSeconds` log `MEETING_STUCK_LOG` each scan. At most `maxConcurrentFinishes` run at once.

#### `src/services/workerShutdown.ts`

Replaces `runtimeShutdownService.ts`. Reuses `createProcessShutdownOwner` (`processShutdownService.ts`, `PROCESS_PRESERVATION_MS` becomes `LIFECYCLE.shutdownBudgetMs`).

```ts
export function installWorkerShutdown(resources: {
  closeServer(): Promise<void>;
  destroyBot(): Promise<void>;
}): ProcessShutdownOwner;
export function failWorkerStartup(error: unknown): void;
```

`preserve`: `beginShutdown()`, `stopWorkerRegistry()` (writes `ready: false` first), stop every poller, `closeAllCaptures({endReason: "unknown", abnormal: true})`, `releaseLocalFinishClaims()`, `closeServer()`, `destroyBot()`.

#### `src/apps/worker.ts`

The composition root that both `bootstrap.ts` and the scenario harness call.

```ts
export function startWorker(options: {
  mode: "all" | "bot" | "api";
}): Promise<{ stop(): Promise<void> }>;
```

No signal handlers and no `process.exit` here; `bootstrap.ts` owns those.

#### `scripts/deployment/deploy.cjs`

One Node script, because rollback and polling need JSON handling and a stubbed `aws` function makes every step unit-testable, which inline bash is not. It shells out to the `aws` CLI like the surviving Terraform helpers.

| Subcommand                      | AWS calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`                     | `ecs describe-services`; `elbv2 describe-listeners` (full-weight target group equals the service's bound group)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `wait-drain [--retire]`         | loop: `ecs describe-services`, `ecs list-tasks`, `ecs describe-tasks`; a RUNNING task whose `taskDefinitionArn` differs from the service's is draining. Gives up at 160 minutes with exit 1 after `cloudwatch put-metric-data` (`<prefix>/Deploy`, `DrainWaitTimedOut`). `--retire` calls `ecs stop-task` for each. Then up to 5 minutes of `dynamodb query` (pk `WORKERS`) until every fresh record with `captures > 0` has `protectedUntil > now`, then exit 0 regardless.                                           |
| `rollout --image <repo@digest>` | `ecs describe-task-definition` (current), strip read-only fields and the `DEPLOYMENT_CANDIDATE_ID` env var, set the image, `ecs register-task-definition`, `ecs update-service --task-definition <new> --health-check-grace-period-seconds 300 --deployment-configuration` `{minimumHealthyPercent:100, maximumPercent:200, earlySuccessCriteria:{enable:true, healthyPercent:100, sourceServiceRevisionCleanup:"DEFERRED"}}` (copied from `coordinator.cjs:491-500`). Prints the new revision and the previous image. |
| `wait-ready --release <n>`      | `dynamodb query` pk `WORKERS` every 10 s for up to 15 minutes: a record with `release = n`, `ready`, `heartbeatAt >= now - 30`                                                                                                                                                                                                                                                                                                                                                                                         |
| `rollback --image <previous>`   | same as `rollout`, then exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

#### `scripts/stranded-meetings.ts`

Operator commands (pattern: `scripts/retry-meeting-processing.ts`). `list` prints each `listStranded` row with what its checkpoint holds (`createRecordingCheckpointService().read`). `finish <guildId> <channelId_timestamp> --post | --no-post` runs `claim(..., {operator: true})` then `finishMeeting(claim, (signal) => loadRecoveryFinishInput(claim.history, signal), {deliver})`. One of `--post` or `--no-post` is required. Output goes through `scripts/privateOutput.ts`.

#### `_infra/alerts-lifecycle.tf`

Copies the shape of `alerts-processing-retry.tf` (filter by `local.app_log_group_name`, namespace `${local.name_prefix}/Logs`, `alarm_actions = [local.critical_alerts_topic_arn]`).

| Alarm                     | Source                                                                                   | Condition                                            |
| ------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `meeting_lifecycle_stuck` | filter `?"Meeting lifecycle stuck" ?"Meeting lifecycle abandoned"`                       | Sum >= 1 in 300 s                                    |
| `meeting_finish_failed`   | filter `?"Meeting finish failed after retries" ?"Meeting delivery failed after retries"` | Sum >= 1 in 300 s                                    |
| `task_protection_failing` | filter `"Task protection failed during capture"`                                         | Sum >= 3 in 300 s                                    |
| `no_eligible_worker`      | filter `"Worker eligible heartbeat"`                                                     | Sum < 1 in 300 s, `treat_missing_data = "breaching"` |
| `deploy_drain_timeout`    | custom metric `${local.name_prefix}/Deploy` `DrainWaitTimedOut`                          | Sum >= 1 in 300 s                                    |

Other Terraform edits are in 1.3.

#### Tests and docs created

`test/scenarios/harness/*` and `test/scenarios/*.integration.test.ts` (section 3, task A3), `docs/deployment.md`, `docs/adr-20261111-lifecycle-simplification.md`.

### 1.3 Files modified

| File                                                                                                                                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/db.ts`                                                                                                                                             | `MeetingHistory` gains `lifecycleVersion?: 2`, `finish?: FinishState`, `startMessageId?: string`. Lease type loses the `"recovery"` variant at the end (stage F).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/types/meeting-data.ts`                                                                                                                                   | `reservation` type comes from `meetingHistoryTransition.ts`. Remove `finalization`, `finalizationFenced`, `ownershipSignal`, `leaseHeartbeatTimer`. `MeetingNotesInput` unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/services/runtimeInstanceService.ts`                                                                                                                      | Add `Revision: z.string()` to `taskMetadata` and `export async function resolveWorkerIdentity(): Promise<{ instanceId: string; release: number; taskArn?: string }>` (ECS: `${ECS_CONTAINER_METADATA_URI_V4}/task`; elsewhere `config.runtime.release`). `resolveRuntimeIdentity` deleted in stage F.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/services/configService.ts`                                                                                                                               | `runtime.release` read from the `WORKER_RELEASE` environment variable as a number, defaulting to 0; drop `runtime.candidateId` in stage F.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/metrics.ts`                                                                                                                                              | Counters `meeting_finish_total{outcome}`, `meeting_finish_retry_total{phase}`, `meeting_delivery_total{outcome}`, `meeting_lease_event_total{event}` (`renew_error`, `retaken`, `lost`, `cap`), `worker_task_protection_total{outcome}`, gauge `worker_eligible`. Exported log constants: `MEETING_STUCK_LOG = "Meeting lifecycle stuck"`, `MEETING_ABANDONED_LOG = "Meeting lifecycle abandoned"`, `MEETING_FINISH_FAILED_LOG = "Meeting finish failed after retries"`, `MEETING_DELIVERY_FAILED_LOG = "Meeting delivery failed after retries"`, `TASK_PROTECTION_FAILED_LOG = "Task protection failed during capture"`, `WORKER_ELIGIBLE_LOG = "Worker eligible heartbeat"`. Remove `local_artifact_cleanup`. |
| `src/meetings.ts`                                                                                                                                             | `initializeMeeting` keeps its name and callers; body delegates to `startMeetingSession`. Extract today's `initializeReservedMeeting` body (after the join) as `export function buildMeetingSession(options, reservation, connection, signal): Promise<MeetingData>`. `deleteMeeting(meeting: MeetingData)` removes the entry only when `meetings.get(meeting.guildId) === meeting`. Delete `getPendingMeetingInitializations`, `stopMeetingInitializations`, fixture calls, `endTtsOnlySession` finalization wrapper (it calls `closeMeeting`).                                                                                                                                                                 |
| `src/commands/endMeeting.ts`                                                                                                                                  | `handleEndMeetingButton`, `handleEndMeetingOther`, `runEndMeetingFlow` keep their names and call `closeMeeting`. `finalizeRecording` splits into `loadNormalFinishInput` (moved) and nothing else. Delete `executeOwnedFinalization`, `fenceMeetingFinalization`, `preserveMeetingFinalizationCapture`, `getMeetingFinalizationCheckpoint`, `retainLocalMeetingArtifacts`. `persistAutoRecordSuppression` loses the work claim and the authority. `handleAutoRecordCancellation` rendering moves to `meetingDelivery.ts`.                                                                                                                                                                                       |
| `src/commands/startMeeting.ts`                                                                                                                                | After posting the "recording started" message (`:504`, `:809`) save `startMessageId` to the row with `transitionMeetingHistory` (best effort, logged). Drop `scope`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/commands/saveMeetingHistory.ts`                                                                                                                          | Delete. Its field builders (`buildNotesMetadata`) move into `meetingFinish.ts`. Listed here because `meetings.ts` imports `saveMeetingStartToDatabase` until E1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/embed.ts`                                                                                                                                                | Builders take a `MeetingPresentation` (plain data) with two adapters, `presentationFromMeeting(meeting)` and `presentationFromHistory(history)`. Voice channel renders as `<#channelId>` and attendees from `participants` when rendering from a row (architect's call). `updateMeetingProcessingMessage` stays for the live processing notice. Summary and notes posting leave this file for `meetingDelivery.ts`.                                                                                                                                                                                                                                                                                             |
| `src/services/discordMessageEditor.ts`                                                                                                                        | `createDiscordMessageTransport` gains `createMessage({channelId, payload, signal}): Promise<unknown>` and `listMessages({channelId, after, limit, signal}): Promise<unknown>`. Delete `createFirstPublicationTransport`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/services/recordingCheckpointService.ts`                                                                                                                  | Repository dependency becomes `MeetingHistoryTransitionRepository`. The publish patch adds `updatedAt` next to `checkpoint` (`:590`), which is the finisher's "last checkpoint" time. Remove fixture evidence. On `stale_owner` see risk R3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/services/meetingHistoryService.ts`                                                                                                                       | `commitOwnedMeetingHistory` uses the new transitions repository; `saveOwnedMeetingHistoryService` deleted (terminal save is `MeetingFinishRepository.save`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/services/meetingRecoveryContent.ts`, `recoveryTranscriptionProcessing.ts`                                                                                | Stay. Lose the `effect` tracker parameter (recipe 1.5) and `recoveryArtifactScope`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/services/tempFileService.ts`                                                                                                                             | Keep `getTempBaseDir`, `getMeetingTempDir`, `ensureMeetingTempDir`, `ensureMeetingTempDirSync`. `cleanupMeetingTempDir` becomes `fs.rm(dir, {recursive: true, force: true})`. Add `export function startLocalSweep(isLive: (meetingId: string) => boolean): () => void`. Delete retention.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/services/runtimeHealthServer.ts` and `src/webserver.ts`                                                                                                  | Both `/health` handlers answer 200 when `hasBeenReady()`, else 503. Delete both `/ready` routes. `webserver.ts:541-543` starts pollers through `onFirstEligible`. Other routes keep answering 503 until `activate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/apps/bootstrap.ts`                                                                                                                                       | Calls `installWorkerShutdown`, `startWorker`. No runtime lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/index.ts`, `src/apps/api/main.ts`, `src/apps/bot/main.ts`                                                                                                | `failRuntimeStartup` becomes `failWorkerStartup`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/bot.ts`                                                                                                                                                  | Plain `Client` (no `ws.buildStrategy`). Interaction rule in 1.6. `guildCreate` and `guildDelete` side effects run only when `isEligible()` and after claiming a receipt (`tryCreateInteractionReceipt` with id `guild-install:<guildId>:<joinedTimestamp>` or `guild-remove:<guildId>:<minute>`). Auto-record evaluation gated on `isEligible()`; `reevaluateOccupiedVoiceChannels` runs from `onFirstEligible`.                                                                                                                                                                                                                                                                                                |
| `src/botInteractionAdmission.ts`                                                                                                                              | Keep `resolveInteractionKind`, `tryClaimInteraction(interaction)`. Delete `respondToClosingSession`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/api/liveMeetings.ts`                                                                                                                                     | Imports move to `meetingLease.ts`. No behaviour change (already keyed by meeting id).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/services/meetingControlWorkerService.ts`                                                                                                                 | Poll gate: eligible workers poll all pending commands; a draining worker polls only commands whose `targetOwnerInstanceId` is its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Background pollers (`processingRetryWorkerService`, `personalMediaUploadWorkerService`, `meetingUpdateDeliveryWorkerService`, `renewalRecoveryWorkerService`) | Each tick returns unless `isEligible()`. Work handle removed per 1.5. `renewalRecoveryWorkerService`: see risk R6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/services/runtimeBillingOperationService.ts`, `runtimeApiOperationService.ts`, `notionOperationLifetime.ts`, `runtimeAdmissionError.ts`                   | Kept, slimmed per 1.5. `RuntimeBillingOwner` and its 51 call sites do not change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/repositories/deploymentControlRepository.ts`                                                                                                             | Final shape: `getRecord(pk, sk)` and `writeSuppression({record, expectedVersion})` with Dynamo and mock implementations. Everything else deleted in stage F.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/types/deploymentControl.ts`                                                                                                                              | Final shape: suppression and paused-draft schemas and keys, `parseDeploymentControlRecord` for those two. 71 importers make deletion impractical; it is slimmed in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/deployment/terraform-workflow.cjs`                                                                                                                   | Remove the three guard requires (`:92`, `:302`, `:386-405`), the `prerequisites` WeakMap and `privatePrerequisiteVerified` (`:86-101`, export `:485`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scripts/deployment/terraform-native.cjs`                                                                                                                     | `productionWriters` (`:105-110`) becomes `["deploy.yml"]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts/deployment/site-publisher-identity.cjs`                                                                                                              | Drop `DEPLOYMENT_CONTROL_TABLE` from the allowed variables and the pin check (`:30`, `:40-46`, `:82`); it must match the edited `deploy.yml` session policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.github/workflows/deploy.yml`, `deploy-staging.yml`                                                                                                          | Jobs: `ci`, `deploy-docs`, `drain-wait` (own OIDC session, `timeout-minutes: 175`, runs `deploy.cjs wait-drain`), `deploybackend` (`needs: [ci, deploy-docs, drain-wait]`: image build and push as today, `preflight`, `rollout`, `wait-ready`, `rollback` on failure), then `deploy-frontend`, `promote-prompts`, `sync-openai-connection` unchanged except every `production-writer-guard` step, the "Configure read-only production hold identity" steps, the guard env and the `dynamodb:GetItem` line in the inline session policies are removed. Delete the `break-glass` job. Add dispatch input `retire_older_tasks` (boolean). Both workflows call the same script.                                    |
| `.github/workflows/terraform-apply.yml`                                                                                                                       | Delete the "Inspect production hold before plan preparation" step (`:132-134`) and the `DEPLOYMENT_GUARD_ROLE_ARN` env.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `.github/workflows/ci-core.yml`                                                                                                                               | Job `deployment-integration` becomes `integration`: no docker build, no `DEPLOYMENT_TEST_IMAGE`, adds `apt-get install ffmpeg`, runs `yarn test:integration`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `jest.config.ts`                                                                                                                                              | Ignore pattern becomes `\\.integration\\.test\\.ts$`. Coverage thresholds unchanged (30/60/40/30).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `jest.deployment-integration.config.ts`                                                                                                                       | Renamed `jest.integration.config.ts`; `testMatch` `**/test/**/*.integration.test.ts`; env var renamed `TEST_DYNAMODB_ENDPOINT`. `package.json` script `test:integration`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `_infra/main.tf`                                                                                                                                              | `aws_ecs_service.app_service`: `health_check_grace_period_seconds = 300`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `_infra/production-deployment.tf`, `sandbox-deployment.tf`                                                                                                    | Deploy role: `cloudwatch:PutMetricData` conditioned on namespace `${local.name_prefix}/Deploy`; `ecs:StopTask` on `task/${cluster}/*` behind `var.ENABLE_DEPLOY_RETIRE` (default false, set through `TFVAR_ENABLE_DEPLOY_RETIRE`). Nothing coordinator-only is removed in this pass.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Docs                                                                                                                                                          | `AGENTS.md` (deploy contract paragraphs, three-step env var note, voice SG note untouched), `.github/copilot-instructions.md`, `README.md`, `_infra/README.md` lines 694-779 and 922-1091, `docs/terraform-private-delivery.md` where it names the guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 1.4 Files and directories deleted

`src/services/`: `runtimeLifecycleService.ts`, `runtimeWorkAdmissionService.ts`, `runtimeStartupService.ts`, `runtimeShutdownService.ts`, `runtimeProtectionService.ts`, `runtimeArtifact*.ts`, `runtimeCompatibleReplacementService.ts`, `runtimeLocalBootstrap*.ts`, `botStartupService.ts`, `deploymentControlTransactions.ts`, `deploymentFixtureAdmission.ts`, `artifact*.ts` (all eight), `legacyArtifactAttestation.ts`, `localArtifactInventory.ts`, `meetingArtifactCleanupService.ts`, `meetingArtifactProducer.ts`, `activeMeetingLeaseService.ts`, `activeMeetingLeaseRelease.ts`, `recordingReservationReleaseProof.ts`, `guildVoiceOperationService.ts`, `ownedMeetingInterruption.ts`, `meetingInterruptionService.ts`, `meetingStopInterruption.ts`, `meetingFinalizationService.ts`, `recordingDeliveryService.ts`, `recordingCanonicalConflict.ts`, `meetingRecoveryService.ts`, `meetingRecoveryWorkerService.ts`, `meetingRecoveryAcknowledgment.ts`, `recoveredRecordingProof.ts`, `recoveryArtifactScope.ts`, `recoveryDiscordPublication.ts`, `recoveryDiscordPublication{Apply,Barrier,Plan,Store}.ts`, `firstPublication*.ts`, `fixture*.ts`, `production*.ts`, `pausedDesktopDraftTransactions.ts`, `personalAdmissionTransaction.ts`.

Kept on purpose: `recoveryDiscordPublicationTypes.ts` (12 importers in meeting update code), `recoveredMeetingLayout.ts` (old rows), `meetingRecoveryContent.ts`, `recoveryTranscriptionProcessing.ts`, `processShutdownService.ts`, `preservationBudget.ts`, `meetingProcessingLifetime.ts`, `meetingCompletionPolicyService.ts`, `personalUploadTransactions.ts`, `repositories/pausedDesktopDraft.ts`, `historyWriterBoundary*`, `ledgerWriter*`, `normalPurchaseWriterWitness.ts` (billing, not deployment).

`src/repositories/`: `deploymentControlReadiness.ts`, `deploymentRepositoryBindings.ts`, `meetingCanonicalWriterAdmission.ts`, `meetingRecoveryRepository.ts`, `artifactSafetyRepository.ts`, `firstPublicationRepository.ts`, `meetingPublicationRepository.ts`. `deploymentControlErrors.ts` stays (7 importers use `classifyDeploymentTransactionError`).

`src/types/`: `productionIntroduction.ts`, `artifactSafety.ts`, `artifactCleanup.ts`, `localArtifact.ts`, `firstPublicationControl.ts`, `retirementContinuation.ts`, `meetingRecovery.ts`. `fixtureEvidence.ts` stays as types only (stored attributes on old rows).

`src/commands/saveMeetingHistory.ts`.

`scripts/`: `recover-meeting-artifacts.ts`, `recoveredMeetingArtifactWrite.ts`, `publish-recovered-meeting.ts`, `first-publication-cli.ts`, `tsconfig.first-publication.json`, `force-deployment.ps1`, `scripts/operator/` (both files).

`scripts/deployment/`: everything except the survivors below. Verified by a require-closure walk from the entry points that `terraform-plan.yml`, `terraform-apply.yml`, `deploy.yml` and `deploy-staging.yml` still invoke after the edits in 1.3.

SURVIVE (27 existing files plus `deploy.cjs`): `terraform-dispatch.cjs`, `terraform-workflow.cjs`, `terraform-bundle.cjs`, `terraform-native.cjs`, `terraform-process.cjs`, `terraform-meeting-update.cjs`, `terraform-meeting-model.cjs`, `terraform-plan-identity.cjs`, `terraform-tfvars.py` (spawned at `terraform-workflow.cjs:182`), `validate-prerequisite-plan.cjs`, `validate-runtime-plan.cjs`, `validate-site-plan.cjs`, `validate-sandbox-site-permissions-plan.cjs`, `validate-processing-retry-plan.cjs`, `validate-artifact-preservation-plan.cjs`, `private-capture.cjs`, `collector-payload.cjs`, `collector-principal.cjs`, `collector-command.cjs`, `binding-hash.cjs`, `maintenance-fence.cjs`, `maintenance-probe.cjs`, `sandbox-site-session.cjs`, `site-publisher-identity.cjs`, `assert-production-identity.cjs`, `assert-sandbox-identity.cjs`, `recompute-source-model.cjs` (documented manual tool for the `sourceModel` pin). Also outside the folder: `_infra/functions/frontend-route-rewrite.js` is read by `validate-site-plan.cjs:22`.

Dropped by the guard removal: `production-writer-guard.cjs`, `coordinator-aws.cjs`.

`.github/workflows/`: `sandbox-identity.yml`, `introduce-production.yml`, `prepare-production-paused-drafts.yml`, `production-cutover.yml`, `production-introduction.yml`, `verify-production-bootstrap.yml`.

`docs/`: `deployment-handoff.md`, `production-introduction.md`, the Sandbox bootstrap documents, the superseded spec and three ADRs named in the spec header (mark superseded, do not delete ADRs).

Tests: section 4.

### 1.5 The work handle: mechanical recipe

Apply to every site in the inventory (about 60 functions, 18 importing modules of `runtimeWorkAdmissionService`). After each file, `grep -n "work\b\|authority\|trackEffect\|RuntimeWorkClaim"` must return nothing.

1. Parameter `work?: RuntimeWorkClaim`: delete it. Keep an existing `signal?: AbortSignal` parameter. Where only `work.signal` was read, add `signal: AbortSignal` and pass `operationSignal()` from the entry point.
2. `beginRuntimeWorkClaim(...)` plus `work.trackPromise(fn)`: becomes `fn()`. The surrounding `try/catch` that handled refusal becomes `if (!isEligible()) return;` in pollers and disappears elsewhere.
3. `work.trackEffect(fn)`, `trackApiMutation(fn)`, `trackBillingMutation(fn)`, `trackTerminalEffect(fn, ...)`, and any `effect` tracker parameter (`RecoveryDependencies.effect`, `RetryWork["trackEffect"]`): become `fn()`; delete the parameter.
4. `await work.authority()` and `getRuntimeAdmissionContext()`: delete, with the argument they fed. Where `context.instanceId` or `context.now` was read, use `getRuntimeInstanceId()` and `Math.floor(Date.now() / 1000)`.
5. `recordClaim`, `claimed`, `delivering`, `acknowledge*`, `settle`, `fence`: delete the line. Where `fence()` was the only way to stop in-flight work after a local failure (lease renewal loss in `processingRetryWorkerService.ts:241`, `meetingUpdateDeliveryState.ts:359`), create `const job = new AbortController()` with the job and use `operationSignal(job.signal)`.
6. `registerRuntimeNotionOwner(work)`: becomes `registerNotionMutationTracker(signal, (run) => run())` with that operation's own signal. `runRuntimeApiOperation(id, run)` keeps its signature and builds `{ signal: operationSignal(), unresolved() {}, read: (f) => f(), mutate: (f) => f() }`.
7. `SessionControlClosing`, `InitiatingStopInterruption`: delete the classes and their catch branches.
8. `runBillingOperation(undefined, run)` calls `lifetime(operationSignal(), (f) => f(), run, () => {})` directly. `runBillingWorkerOperation(signal, run)` loses `work`. `runBillingReceiptOperation(id, admit, run)`: `admit` takes no context.

### 1.6 Interaction routing (`src/bot.ts`)

```text
ownerControl = isOwnerInteraction(interaction)           // end_meeting button, leave, say, dismiss (unchanged predicate)
local = ownerControl && getMeeting(interaction.guildId)  // live capture in this worker's memory
if (local)            -> claim receipt, then defer (or reply), then handle
else if (!isEligible()) -> return
else if (ownerControl) -> read lease; active -> return silently (its owner answers);
                          absent or expired -> claim receipt, reply "The recording has ended. Notes will follow."
else                   -> claim receipt, then defer or showModal, then handle
```

Nothing but the receipt write precedes the first response on the first and last branches.

### 1.7 Embedded deployment admission checks: delete X, keep Y

| #     | Site                                                                                                                                | Delete                                                                      | Keep                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | `db.ts:569` `tryCreateInteractionReceipt`                                                                                           | `authority` param, transaction branch `:601-611`, mock branch `:587-600`    | Put `attribute_not_exists(interactionId)` (or `... OR expiresAt <= :now`)                                          |
| 2     | `deploymentControlRepository.ts:327` `writeSuppression`                                                                             | `authority`, `buildWorkAdmissionChecks` `:342`, identity check `:329-335`   | Put `attribute_not_exists(pk)` or `#version = :version`                                                            |
| 3     | `meetingControlCommandRepository.ts:145` `writeCommand`                                                                             | `context`, `:156-163`                                                       | `attribute_not_exists(#requestId)`                                                                                 |
| 4     | same `:221` `claimCommand`                                                                                                          | `:243-249`; `validClaimAuthority` reads owner from `getRuntimeInstanceId()` | `#queueStatus = :pending AND expiresAt > :now AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)` |
| 5     | `processingRetryRepository.ts:421` `send`                                                                                           | transaction wrapper `:430-438`, always `UpdateItemCommand`                  | `retryUpdate` conditions `:370`                                                                                    |
| 6     | `meetingUpdateDeliveryRepository.ts:514` `persist`, `:167` `claimDelivery`                                                          | `:538`; owner and now come from arguments                                   | `conditionalUpdate` `:343`                                                                                         |
| 7     | same `:591` `updateContentAndDelivery`                                                                                              | `canonicalChecks` `:600-608`                                                | `conditionalUpdate` plus `buildPersonalClaimCheck`                                                                 |
| 8     | `stripeWebhookDynamoRepository.ts:92` `admit`                                                                                       | `:113`, `context` param                                                     | the receipt state expression (lease token, birth, continuation)                                                    |
| 9-12  | `db.ts:2171, 2204, 2453, 2467` personal upload and segment writes                                                                   | `transactPersonalAdmission` wrapper, `context`                              | each function's own items including `buildUnpausedDesktopDraftCheck`                                               |
| 13    | `db.ts:2497` personal claim (`buildPersonalMediaClaimTransaction`, moved to `personalUploadTransactions.ts`)                        | `buildRuntimeAdmissionChecks` `:128`                                        | paused-draft check plus the claim expression                                                                       |
| 14    | `reserveSession`                                                                                                                    | whole function, replaced by `MeetingLeaseRepository.startSession`           | lease, history and suppression conditions (no voice item)                                                          |
| 15-16 | `meetingRecoveryRepository.ts:413, 533`                                                                                             | whole module                                                                | none                                                                                                               |
| 17    | `checkAdmission` and its 4 callers (`bot.ts:719, 739`, `runtimeApiOperationService.ts:45`, `runtimeBillingOperationService.ts:178`) | all                                                                         | none                                                                                                               |
| 18    | `buildOwnedCheckpointTransition`                                                                                                    | nothing: it is the lease check, moved to `leaseOwnershipCheck`              | unchanged                                                                                                          |

Thirteen mock-path equivalents go with them (`mockWorkAdmissionAllowed` callers). Stripe receipt rows keep their stored `birth.writer` and `admission` fields; new receipts stop writing `admission.runtime` and `generation` (verify the Zod schema in `types/stripeWebhookReceipt.ts` allows absence before deleting, otherwise write constants).

---

## 2. Data shapes

No new status values. `MEETING_STATUS` and `MEETING_END_REASONS` are untouched.

MeetingHistory, added:

| Attribute          | Type              | Written by                                                           |
| ------------------ | ----------------- | -------------------------------------------------------------------- |
| `lifecycleVersion` | `2`               | start transaction only                                               |
| `startMessageId`   | string            | after the "recording started" message is posted                      |
| `finish`           | `FinishState` map | close step 4, finisher, pipeline; removed when nothing is left to do |

**MeetingHistory, existing attributes with a new writer**: `capture`, `endReason`, `endTriggeredByUserId`, `duration` and `status: processing` at close step 4 (or derived at adopt); `updatedAt` on every checkpoint publication; `summaryMessageId`, `notesMessageIds` (appended per chunk), `notesChannelId`, `delivery`, `notesDeliveryTiming` by delivery; `recovery` only as the delivery done marker.

**MeetingHistory, no longer written** (left in place on old rows and read normally): `recovery` in any state other than the done marker, `recoveryExport`, `recoveryTranscript`, `publicationRepair`, `operatorRecovery`, `fixtureInput`, `fixtureGeneration`, `fixtureTranscript`, `chatS3Key` for meetings finished by the recovery loader. `executionVersion` stays `1`. `ownerInstanceId`, `canonicalWriter` and `completionPolicy` are written at start exactly as today.

**Lease item (ActiveMeetingTable, key `guildId`)**: shape unchanged. No longer written: `sessionMode: "recovery"`, `recoveryAttemptId`, any `executionVersion` other than 1.

**DeploymentControlTable**: new items `{pk:"WORKERS", sk:"WORKER#<instanceId>"}` (`WorkerRecord`) and `{pk:"WORKERS", sk:"CUTOVER"}`. No longer written: `ENV/CONTROL`, `ENV/RUNTIME#*`, `ENV/INTRODUCTION`, `VOICE#*/STATE`, `FIXTURE#*`, `ENV/ARTIFACTS#*`, `PUBLICATION#*`, `UPLOAD#*/PAUSED_DRAFT` installs. Existing items are not deleted. `SUPPRESS#*` and `UPLOAD#*/PAUSED_DRAFT` reads are unchanged.

---

## 3. Task list

Gates after every task: `yarn lint:check`, `yarn test`, `yarn build:all`, and the bot starts with `yarn dev`. "Green: yes" means the full unit suite. Scenario numbers are the spec's.

New repositories follow the existing convention: a Dynamo implementation and a `getMockStore()` implementation chosen by `config.mock.enabled`, with one contract test file run against both (pattern: `test/repositories/meetingUpdateDeliveryContract`).

### Stage A: foundations (one engineer; A1 first, then A2, A3, A4 in parallel)

**A1. Lifecycle constants, shutdown signal, row types, metrics**
Create `lifecycleTiming.ts`, `shutdownSignal.ts`; modify `types/db.ts`, `metrics.ts`. Produces `LIFECYCLE`, `operationSignal`, `FinishState` type location (declare `FinishState` in `types/db.ts`, re-exported by the finish repository), log constants. Test: `test/services/shutdownSignal.test.ts` ("operation signals are distinct and follow shutdown"), `test/services/lifecycleTiming.test.ts` ("lease cap is duration plus grace"). Green: yes. Parallel: none (everything consumes it).

**A2. Extract history transitions**
Create `types/meetingHistoryTransition.ts`, `repositories/meetingHistoryTransitions.ts`; modify `db.ts`, `types/deploymentControl.ts` (re-export the moved names so nothing else changes yet), `deploymentControlRepository.ts` and `deploymentControlTransactions.ts` (delegate). Consumes A1. Produces `getMeetingHistoryTransitionRepository`, `leaseOwnershipCheck`. Test: `test/repositories/meetingHistoryTransitions.contract.ts` run by `meetingHistoryTransitions.test.ts` (mock) and `test/deployment/checkpointPersistence.integration.test.ts` (existing, repointed). Green: yes. Parallel: A3, A4.

**A3. Scenario harness**
Create `test/scenarios/harness/{world,tables,fakeDiscord,fakeVoice,fakeStorage,fakeOpenAI}.ts`, `test/scenarios/harness.integration.test.ts`; rename the integration jest config; modify `jest.config.ts`, `package.json`, `ci-core.yml`. Consumes A1. Produces:

```ts
export function createWorld(): Promise<World>;
type World = {
  discord: FakeDiscord; // guilds, channels, members; rest.posts(), rest.failNext(status, times), rest.onPost(hook)
  storage: FakeStorage; // objects Map shared by all workers
  openai: FakeOpenAI; // transcription and text scripts, failNext(kind, times)
  startWorker(options: {
    release: number;
    instanceId?: string;
  }): Promise<ScenarioWorker>;
  seedLegacyRuntime(heartbeatAt: number): Promise<void>;
  rows: {
    history(guildId): Promise<MeetingHistory[]>;
    lease(guildId): Promise<ActiveMeetingLease | undefined>;
    registry(): Promise<RegistryView>;
  };
  dispose(): Promise<void>;
};
type ScenarioWorker = {
  instanceId: string;
  command(
    name: string,
    options: object,
    as: FakeMember,
  ): Promise<FakeInteraction>;
  button(
    customId: string,
    messageId: string,
    as: FakeMember,
  ): Promise<FakeInteraction>;
  speak(guildId: string, userId: string, pcm: Buffer): void;
  joinVoice(guildId: string, channelId: string, member: FakeMember): void;
  network: { block(): void; unblock(): void }; // gates this worker's DynamoDB client
  kill(): void; // every seam of this worker throws from now on; no cleanup runs
  sigterm(): Promise<void>; // runs the real shutdown preserve path without process.exit
};
```

What is faked and where:

- DynamoDB: real, local, as the integration config already does. Tables come from running `scripts/init-dynamodb.js` through `test/scripts/dynamoInitScript.fixture.ts` with a real client and a random `DDB_TABLE_PREFIX`. Per worker, `jest.doMock("src/repositories/dynamoClient")` wraps the client `send` in the `network` gate.
- Object store: `jest.doMock("src/services/storageService")` with a Map-backed implementation of its exports.
- Discord: `jest.doMock("discord.js")` returning the real module with a `Client` subclass whose `login` emits `ClientReady` without a socket and whose `rest` uses `makeRequest` pointed at `FakeDiscord.rest`. Global `fetch` is stubbed for `https://discord.com/api` to the same handler (this is what `discordMessageEditor` calls). Guild, channel and member objects are built as `test/fixtures/meetingStart.ts` does. Seed: `test/deployment/meetingPublicationHttp.fixture.ts`.
- Voice: `jest.doMock("@discordjs/voice")` with a fake `joinVoiceChannel` returning an EventEmitter connection (`receiver.speaking`, `receiver.subscribe` giving a stream the test pushes into, `destroy(adapterAvailable)` recorded as leave or local drop). `prism-media` Opus decoding is mocked as passthrough, as `test/audio/voiceSubscriptions.test.ts` does. Real ffmpeg is used.
- OpenAI and prompts: `jest.doMock("src/services/openaiClient")` returning a client whose `audio.transcriptions.create` and `responses.create` are scripted (`src/testSupport/openaiResponse.ts`), and `jest.doMock("src/services/langfusePromptService")` serving the repo's prompt files.
- Time: `jest.doMock("src/services/lifecycleTiming")` with second-scale values (lease 2 s, heartbeats 500 ms, finisher 1 s, backoff 1, 2, 3 s). Real clock. No fake timers.
- Workers: each `startWorker` runs inside `jest.isolateModulesAsync` with its own `BOT_INSTANCE_ID` and `WORKER_RELEASE`, so module singletons are per worker. Until E2 lands `startWorker` throws "worker entry not available"; module-level scenario tests in stages B and C use the fakes directly.

Test: `harness.integration.test.ts` ("tables exist under a private prefix", "REST fake records a post and replays a scripted failure", "voice fake delivers audio to a subscriber", "object store round trip", "killed worker cannot write"). Green: yes. Parallel: A2, A4.

**A4. Worker registry and eligibility**
Create `workerRegistryRepository.ts`, `workerEligibility.ts`, `workerRegistry.ts`; modify `runtimeInstanceService.ts`, `configService.ts`. Not started by bootstrap yet (the old runtime in the same process would hold it in standby). Consumes A1. Produces 1.2 signatures. Test: `test/services/workerEligibility.test.ts` (table: "not ready", "shutting down", "higher release fresh", "higher release stale", "same release", "legacy fresh gives standby", "legacy stale two minutes writes cutover", "cutover ignores fresh legacy", "no legacy rows writes cutover"), `test/repositories/workerRegistryRepository.contract.ts` (mock and local Dynamo), `test/services/workerRegistry.test.ts` ("failed read keeps last view", "health latch survives ready false"). Scenario 14 at registry level in `test/scenarios/registry.integration.test.ts`. Green: yes. Parallel: A2, A3.

### Stage B: capture side (one engineer; B1, B2, B3 in parallel, then B4, then B5)

**B1. Lease repository and service**
Create `meetingLeaseRepository.ts`, `meetingLease.ts`. Consumes A1, A2. Test: `test/repositories/meetingLeaseRepository.contract.ts` ("start loses to a live lease", "start wins over an expired lease", "suppressed channel refuses", "retake refuses another meeting"), `test/services/meetingLease.test.ts` ("renewal error keeps recording", "condition failure with absent lease retakes", "condition failure with another meeting calls onLost once", "no renewal past the cap"). Scenarios 8 and 11 at lease level in `test/scenarios/lease.integration.test.ts`. Green: yes. Parallel: B2, B3, all of C and D.

**B2. Task protection**
Create `taskProtection.ts`. Consumes A1, `latestLeaseCap` by injection. Test: `test/services/taskProtection.test.ts` ("expiry is ten minutes past the latest cap", "refused call is counted and not thrown", "clear retries until success", and scenario 15: "no extension without an unexpired lease"). Green: yes. Parallel: B1, B3.

**B3. Voice session**
Create `voiceSession.ts`. Test: `test/services/voiceSession.test.ts` ("join times out through the signal", "local drop sends no voice state"). Green: yes. Parallel: B1, B2.

**B4. Start**
Create `meetingStart.ts`; modify `meetings.ts` (extract `buildMeetingSession`, old path keeps using it). Consumes B1, B2, B3, A2. Test: `test/services/meetingStart.test.ts` ("row is written with lifecycleVersion 2 before voice", "join failure marks failed and releases"), scenarios 12 and 13 (start half) in `test/scenarios/start.integration.test.ts`. Green: yes. Parallel: C tasks, D tasks not touching `meetings.ts`.

**B5. Close**
Create `meetingClose.ts`. Consumes B1 to B4, C1 (`recordCaptureEnd`). Test: `test/services/meetingClose.test.ts` ("step 4 is retried", "lease is released when step 3 throws", "draining worker writes no claim", "lost lease sends no leave and writes interrupted"), scenario 11 second half in `lease.integration.test.ts`. Green: yes. Parallel: C2 to C5.

### Stage C: finish side (one engineer; C1 first, then C2 and C3 in parallel, then C4, C5)

**C1. Finish repository**
Create `meetingFinishRepository.ts`. Consumes A1, A2. Test: `test/repositories/meetingFinishRepository.contract.ts` ("claim refuses a live claim", "claim takes an expired claim", "claim respects nextAttemptAt", "adopt refuses while the lease names the meeting", "save refuses after losing the claim", "scan returns only marked open rows", "abandon is idempotent"). Green: yes. Parallel: B1 to B4.

**C2. Loaders**
Create `meetingFinishInput.ts`; modify `meetingRecoveryContent.ts`, `recoveryTranscriptionProcessing.ts` only by adding exports. Consumes A1. Test: `test/services/meetingFinishInput.test.ts` ("recovery loader with no manifest reports no saved audio", "recovery loader transcribes only untranscribed pieces", "normal loader reuses the in-memory compile"). Green: yes. Parallel: C3.

**C3. Delivery**
Create `meetingDelivery.ts`; modify `embed.ts` (presentation adapters), `discordMessageEditor.ts`. Test: `test/services/meetingDelivery.test.ts` ("render from row equals render from live meeting for the same content", "resume counts leading chunks by meeting timestamp", "403 is permanent", "429 is temporary", "missing start message posts a new summary"), `test/embed.test.ts` updated. Scenarios 4, 5, 6 at module level in `test/scenarios/delivery.integration.test.ts`. Green: yes. Parallel: C2.

**C4. Pipeline**
Create `meetingFinish.ts`. Consumes C1, C2, C3. Test: `test/services/meetingFinish.test.ts` ("each step is skipped when its output exists", "backoff 1, 5, 15 then final", "delivery backoff then hourly then give up at 24 hours", "claim loss aborts the attempt"), scenarios 7 and 13 in `test/scenarios/finish.integration.test.ts`. Green: yes.

**C5. Finisher loop**
Create `meetingFinisher.ts`. Consumes C1, C4, B1 (`read`). Test: `test/services/meetingFinisher.test.ts` (table over `classifyFinisherRow`, including the two minute grace and the 24 hour rule), scenario 3 at module level and scenarios 4 and 5 through the loop in `test/scenarios/finisher.integration.test.ts`. Green: yes.

### Stage D: feature decoupling (two engineers; all parallel except where a file is shared)

Each task applies 1.5 and 1.7 to one feature and keeps the old runtime running. Pollers keep starting from `whenRuntimeServing` until E2.

**D1. Interaction receipts and bot interaction path** (`db.ts` receipts section, `interactionIdempotencyService.ts`, `botInteractionAdmission.ts`, `bot.ts` interaction and suppression handlers, `commands/leave.ts`, `commands/dismissAutoRecord.ts`, `autoRecordJoinSuppressionService.ts`, row 2). Test: `test/dbInteractionReceipt.test.ts`, `test/services/autoRecordJoinSuppressionService.test.ts` updated. Green: yes. Parallel: D3 to D6. Not parallel with D2 (`db.ts`) or E tasks (`bot.ts`).

**D2. Personal uploads** (`db.ts` personal section, `personalMediaUpload{Service,WorkerService,Repository}.ts`, `personalRecordingSegmentRepository.ts`, `personalUploadTransactions.ts`; delete `personalAdmissionTransaction.ts`). Rows 9 to 13. Test: existing personal upload suites plus `test/deployment/pausedUploadQueue.integration.test.ts` updated. After D1.

**D3. Billing and Stripe receipts** (`runtimeBillingOperationService.ts`, `stripeWebhook*Repository.ts`, `stripeWebhookReceiptService.ts`, `renewalRecoveryWorkerService.ts`, `api/billing.ts`). Row 8. Money path: review as a billing change. Test: `test/services/runtimeBillingOperationService.test.ts`, `test/deployment/stripeReceipt.integration.test.ts` updated.

**D4. API operations, Notion, notes correction** (`runtimeApiOperationService.ts`, `notionOperationLifetime.ts`, `trpc/trpc.ts`, `meetingUpdateService.ts`, `meetingUpdateDeliveryRepository.ts` row 7, `mockMeetingUpdateDeliveryRepository.ts`). Test: existing notes correction and Notion suites.

**D5. Meeting update delivery worker and processing retry** (`meetingUpdateDelivery{Types,State,Service,Observe,WorkerService}.ts`, repository row 6, `processingRetry{Repository,WorkerService,Stages}.ts` row 5). After D4 (shared repository file). Test: `test/deployment/meetingUpdateDelivery*.integration.test.ts`, `processingRetryRepository.integration.test.ts`, worker unit suites.

**D6. Control command queue** (`meetingControlCommandRepository.ts`, `meetingControlQueueService.ts`, `meetingControlWorkerService.ts`, `meetingControlBotService.ts`; remove `productionFixtureCommandService` use). Rows 3, 4. Test: existing control suites.

### Stage E: switch-over (one engineer, strictly sequential)

**E1. Switch start, close and finish**
Modify `meetings.ts`, `commands/startMeeting.ts`, `commands/endMeeting.ts`, `bot.ts` (voice handlers), `embed.ts`, `meetingControlBotService.ts`, `api/liveMeetings.ts`, `recordingCheckpointService.ts`, `meetingHistoryService.ts`, `audio.ts`, `recordingCaptureFailure.ts`, `types/meeting-data.ts`; delete `commands/saveMeetingHistory.ts`. The old runtime still gates admission in memory (`isRuntimeWarm`). Consumes all of B and C and D1, D6. After it nothing imports `activeMeetingLeaseService`, `guildVoiceOperationService`, `ownedMeetingInterruption`, `recordingDeliveryService`, `meetingFinalizationService` except the old shutdown and startup services. Test: `test/commands/startMeeting.test.ts`, `endMeeting.test.ts` rewritten around `closeMeeting`; `src/__tests__/meetings.test.ts` updated. Green: yes.

**E2. Switch the worker lifecycle**
Create `workerShutdown.ts`, `apps/worker.ts`; modify `apps/bootstrap.ts`, `index.ts`, `apps/*/main.ts`, `runtimeHealthServer.ts`, `webserver.ts`, `bot.ts` (1.6, install and removal receipts, auto-record gating), all pollers (eligibility gate), `tempFileService.ts` (sweep). Consumes A4, E1, all of D. After it nothing imports `runtimeLifecycleService`, `runtimeStartupService`, `runtimeShutdownService`, `botStartupService`, `meetingRecoveryWorkerService`. Test: `test/services/runtimeHealthServer.test.ts` ("503 before the first ready write, 200 after, 200 after ready turns false"), `test/services/workerShutdown.test.ts` ("ready false is written before captures close"), new behaviour tests replacing the syntax-tree tests of `bot.ts` (`test/bot.interactionRouting.test.ts`: "owner control is handled by the recording worker", "non-eligible worker ignores a start", "ended recording reply", "install side effect is claimed once"). Green: yes.

**E3. Worker-level scenarios**
Create `test/scenarios/{meeting,deployment,failure}.integration.test.ts`; wire `World.startWorker` to `startWorker`. Implements scenarios 1, 2, 3, 8, 9, 10, 11, 12, 14 end to end through interactions, and re-runs 4, 5, 6, 7, 13, 15 with real workers. No source changes expected; fixes go back to the owning module. Parallel with all of F and G.

### Stage F: deletion (two engineers, parallel after E2; see section 4 for the ledger)

**F1. Runtime, deployment control, lease and voice modules**: delete the modules of 1.4 whose last importer went in E1 or E2, slim `deploymentControlRepository.ts`, `types/deploymentControl.ts`, drop the `"recovery"` lease variant; move the `history` fixture out of `test/deployment/controlFixtures.ts`.
**F2. Fixture mode and artifact tracking**: remove `isFixture` and friends from the 19 importers of `fixtureInputService.ts`, remove `getMeetingArtifactProducer(...)?.beginWrite` and `settle` from 7 files, delete `fixture*`, `production*`, `artifact*`, `meetingArtifact*`, `localArtifactInventory`, `legacyArtifactAttestation`. Architect's call: the spec lists acceptance tooling and artifact safety; this is their in-process half.
**F3. Operator publication and recovery modules**: `firstPublication*`, `recoveryDiscordPublication{,Apply,Barrier,Plan,Store}`, `meetingRecovery{Service,WorkerService,Acknowledgment}`, `recoveredRecordingProof`, `recoveryArtifactScope`, their repositories and scripts.
**F4. Standalone test deletions** (section 4).
F1 before F2 only where both touch `meetings.ts`; otherwise parallel. Green after each: yes; coverage thresholds are checked after F4 and must stay at or above 30/60/40/30 without edits to `jest.config.ts`.

### Stage G: deployment path, infrastructure, docs (one engineer; parallel with B to F after A4)

**G1. Deploy script**: create `scripts/deployment/deploy.cjs`, `test/scripts/deployWorker.test.js` ("preflight refuses a mismatched target group", "drain wait returns when no older task runs", "drain wait times out at 160 minutes and publishes the metric", "protection wait proceeds after five minutes", "rollout keeps early success with deferred cleanup", "ready wait needs a fresh ready record on the new release", "rollback registers a higher revision").
**G2. Workflows and guard removal**: edit `deploy.yml`, `deploy-staging.yml`, `terraform-apply.yml`, `terraform-workflow.cjs`, `terraform-native.cjs`, `site-publisher-identity.cjs`; delete the six workflows and the non-surviving `scripts/deployment` files; update or delete the `test/scripts` files that read them. Check: `node scripts/deployment/terraform-dispatch.cjs --validate` and the surviving `test/scripts/terraform*.test.js` pass.
**G3. Terraform**: `alerts-lifecycle.tf`, grace period, role statements; `terraform -chdir=_infra test`, checkov, `test/scripts/lifecycleAlarms.test.ts` ("every alarm log constant has a filter with the identical string").
**G4. Docs**: 1.3 docs row, `docs/deployment.md` (including the first-deployment procedure and the stranded-meeting commands), the ADR. `yarn docs:check`, `yarn markdownlint:check`.

---

## 4. Deletion ledger

### Source modules

| Module                                                                                | Non-test importers today                                                                             | Last importer removed in                                              | Deleted in |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| `runtimeWorkAdmissionService`                                                         | 18 (non-obvious: `notionOperationLifetime`, `meetingUpdateDeliveryTypes`, `meetingStopInterruption`) | D1 to D6, then E2 (`runtimeShutdownService`)                          | F1         |
| `runtimeLifecycleService`                                                             | 14 (non-obvious: `stripeWebhookReceiptService` `getRuntimeReadiness`, `webserver`)                   | D3, E2                                                                | F1         |
| `runtimeStartupService`, `runtimeShutdownService`, `botStartupService`                | 1, 4, 1                                                                                              | E2                                                                    | F1         |
| `runtimeProtectionService`                                                            | 3 (`runtimeInstanceService` imports a timeout constant)                                              | E2; move `RUNTIME_AGENT_TIMEOUT_MS` to `lifecycleTiming.ts` in A4     | F1         |
| `runtimeArtifact*`, `runtimeLocalBootstrap*`, `runtimeCompatibleReplacementService`   | 2 to 3 each, all inside the runtime cluster                                                          | E2                                                                    | F1         |
| `deploymentControlTransactions`                                                       | 11 (non-obvious: `stripeWebhookDynamoRepository`, `processingRetryRepository`, `db.ts`)              | D2, D3, D5, D6, A2, then F1 slimming of `deploymentControlRepository` | F1         |
| `activeMeetingLeaseService`                                                           | 12 (non-obvious: `fixtureInputService`, `meetingControlQueueService`, `api/liveMeetings`)            | E1, F2                                                                | F1         |
| `guildVoiceOperationService`                                                          | 5 (`bot.ts` uses `buildOwnedVoiceStrategy`)                                                          | E1, E2                                                                | F1         |
| `ownedMeetingInterruption`, `meetingInterruptionService`                              | 7, 1 (non-obvious: `recordingCaptureFailure`, `commands/startMeeting`)                               | E1, E2                                                                | F1         |
| `recordingDeliveryService`                                                            | 2 (`embed.ts`, `endMeeting.ts`)                                                                      | E1                                                                    | F1         |
| `meetingFinalizationService`, `meetingStopInterruption`                               | 2, 6                                                                                                 | E1, D1, D6                                                            | F1         |
| `meetingRecoveryService`, `meetingRecoveryWorkerService`, `meetingRecoveryRepository` | 1, 3, 2                                                                                              | E2                                                                    | F3         |
| `meetingCanonicalWriterAdmission`                                                     | 2                                                                                                    | D4                                                                    | F1         |
| `deploymentRepositoryBindings`, `deploymentControlReadiness`                          | 1, 1                                                                                                 | F1                                                                    | F1         |
| `fixtureInputService`                                                                 | 19 (audio, prompts, uploads, tts)                                                                    | F2                                                                    | F2         |
| `meetingArtifactProducer`, `artifactProducerRegistry`                                 | 7, 5 (non-obvious: `transcriptionInputService`, `types/transcriptionContent`)                        | F2                                                                    | F2         |
| `meetingArtifactCleanupService`                                                       | 5 (`tempFileService`)                                                                                | E2, F2                                                                | F2         |
| `firstPublication*`, `recoveryDiscordPublication*` (not `Types`)                      | scripts only, plus `discordMessageEditor` dynamic import                                             | C3 (transport), F3                                                    | F3         |
| `types/productionIntroduction`                                                        | 21 (`NewWorkScope` threads through start and control)                                                | D6, E1, F2                                                            | F2         |
| `commands/saveMeetingHistory`                                                         | `meetings.ts`, `endMeeting.ts`                                                                       | E1                                                                    | E1         |

### Tests

With the task that removes their subject:

- D tasks: `test/services/runtime{BillingOperationService,ApiOperationService,CorrectionAdmission,InteractionArtifactAdmission}.test.ts` rewritten or deleted; `test/deployment/{workClaims,task3Producers,meetingCanonicalAdmission,meetingMixedVersionCanonical,runtimeWorkAdmission,workerOwnership,pausedWorkerOwnership}` deleted or rewritten against the new signatures.
- E1: `test/commands/{endMeetingPreservation,saveMeetingDelivery}.test.ts`, `test/services/{activeMeetingLeaseService,activeMeetingLeaseRelease,guildVoiceOperationService,ownedMeetingInterruption,meetingInterruptionService,recordingDeliveryService,recordingDeliveryComposition,recoveredLocalAdmission,recoveredOwnedMeeting}.test.ts`, `test/repositories/activeMeetingLeaseRenewal.test.ts` (kept, the helper survives), `test/deployment/meetingInitialPublication.integration.test.ts`.
- E2: `test/services/runtime*.test.ts` (all 18 except `runtimeHealthServer`, `runtimeInstanceService`, rewritten), `test/services/meetingRecovery{WorkerService,Shutdown,Lease}.test.ts`, `test/deployment/{containerShutdown,containerOutputOwnership}.integration.test.ts` and `containerFixture.ts`.
- F1: `test/repositories/deploymentControlRepository.test.ts` (slimmed), `test/deployment/{admissionRace,controlTransactions,stoppedOutgoingContinuation,promotionPreservation,recoveryLease,routingHandoff,warmHandoff,fixtureCommand}*`.
- F2: `test/services/{artifact*,productionFixture*,productionAcceptance*,productionPausedInitialization,fixtureInputService}.test.ts`, `test/types/artifactSafety.test.ts`, `test/deployment/{artifact*,legacyArtifactAttestation*,productionAcceptance*,productionIntroduction*,productionMaintenance,productionOrchestration,productionPausedProjection,productionCarryforward}*`.
- F3: `test/services/{meetingRecoveryService,meetingRecoveryNotion,firstPublication*,recoveryDiscordPublication*}.test.ts`, `test/repositories/firstPublicationRepository.test.ts`, `test/trpc/firstPublicationArchive.test.ts`, `test/deployment/{recordingRecoveryFaults,meetingRepairWorker,meetingUpdateOwnership,firstPublicationWorkflow}*`, `test/scripts/{firstPublicationCli,firstPublicationRelease,firstPublicationDeploymentGate,publishRecoveredMeeting}.test.*`.
- G2: every `test/scripts` file whose script is deleted (coordinator, break-glass, bootstrap verification, cold cutover, collector host, inventory, metadata, session, command beyond what survivors use, production*, sandbox introduction, carryforward, recovery, source loss, retained*, staged*, rehearsal, paused draft, legacy attestation, maintenance tests that load `legacy593a.json`), `test/deployment/{carryforward,preparingRecovery,sandbox*,sourceLoss}*` and `test/deployment/fixtures/*` except `loopbackDynamoMock.ts`, `ownedDynamoTables.ts`, `localControlTable.ts` (generic part). `test/scripts/productionWriterGuard.test.js`, `productionWorkflow*.test.js` deleted; `openaiConnectionDeployment`, `sitePublisherIdentity`, `docsDeployment`, `terraformDispatch`, `deployConcurrency` updated for the new `deploy.yml`.

Surviving `test/scripts` (subjects survive): `terraform*`, `deployment{PrerequisitePlan,ProcessingRetryPlan,RuntimePlan,SitePlan,ArtifactPreservationPlan,SandboxSitePermissionsPlan}`, `sandboxArtifactPlan`, `sandboxSiteChecks`, `sandboxSiteSession`, `sandboxDeploymentIdentity`, `productionIdentity`, `productionDeploymentIdentity`, `collectorPayload`, `collectorPrincipal`, `collectorPreparation`, `privateCapture`, `maintenanceFence`, `recomputeSourceModel`, and everything not about deployment.

Standalone deletions (F4):

- Syntax-tree source-shape tests: `test/bot.voiceFailureBoundaries.test.ts`, `test/meetings.{initializationNoticeOwnership,nicknameOwnership,voiceFailureBoundaries}.test.ts`, `test/fixtures/failedInitializationRuntime.ts`, `test/audio/fixtures/voiceCaptureExit.cjs` with `test/audio/processExit.test.ts`, the one extraction test in `test/commands/startMeeting.test.ts`. `test/commands/onboard.test.ts` and `test/services/guildInstallerOnboardingService.test.ts` are rewritten in E2 against the exported install handler, not deleted, because they assert real behaviour.
- Tests of scripts nothing invokes, where the script is also deleted: `trustedCollector`, `collectorHost`, `collectorInventory`, `collectorMetadata`, `collectorSession`, `sandboxAwsCli`, `rehearsalManifest`, `productionPausedPreparationPolicy`. Operator tools that stay documented (`announce`, `billing-renewal-recovery`, `repair-meeting-share-index`, `retry-meeting-processing`) keep their tests.
- The image build inside the integration job and `test/deployment/fixtures/Dockerfile` (already unreferenced), `nativeShutdown.cjs`, `nativeRecoveryFaults.cjs`.

---

## 5. Open risks

**R1. Carrying the meeting id in each notes message collides with meeting update delivery.** The correction path parses published notes strictly: `meetingUpdateRender.ts:55-65` throws `unsupported_footer` for any footer that is not `v<n>...` or a known notice, and `hasNotesEmbedShape` (`discordEmbedLayout.ts:15`) rejects an embed with a `url`. Edits re-render every page from the first slot (`{...first, ...embed}`), so a url marker would spread to all embeds of a message, and Discord merges same-url embeds. The embed `timestamp` is the only carrier that those modules already pass through untouched. What to do: C3 uses the meeting start timestamp, compares with `Date.parse` equality, and Sandbox acceptance confirms Discord echoes millisecond precision; if it does not, compare at second precision.

**R2. `originalPublicationSettled` needs `recovery.disposition === "done"` for any row with `ownerInstanceId`.** New rows always have an owner. If delivery does not write the done marker, notes correction stays "held" and portal retry reports "processing in progress" forever. What to do: the marker is part of the final delivery save (1.1), and C3 has a test that a delivered row satisfies `originalPublicationSettled`. A correction made between the terminal save and delivery completion gets policy `held: legacy_publication_unknown`; add a test and, if it fails, extend `settledLifecycleDelivery` to release that hold for `lifecycleVersion: 2` rows.

**R3. The checkpoint publisher treats an expired lease as `stale_owner`.** `leaseOwnershipCheck` requires `leaseExpiresAt >= :now`, and `recordingCheckpointService.ts` returns `stale_owner` at six sites. Under the new rule a late renewal is unknown, not lost, so a worker that retakes its lease must be able to keep publishing. What to do: in E1, on `stale_owner` the capture calls `confirmSessionLease` and retries the publish once; only `"lost"` fences the capture. Scenario 11 (first half) is the proof.

**R4. `test/deployment/controlFixtures.ts` is imported by about 75 test files outside its folder** for its generic `history` row. Deleting it in F1 breaks unrelated suites. What to do: F1 first moves `history` to `test/fixtures/meetingHistory.ts` and repoints importers mechanically, then deletes the rest.

**R5. Two workers in one Jest process share module singletons** (`client` in `bot.ts:183`, the `meetings` map, the instance id constant). What to do: the harness isolates modules per worker (A3). If `jest.isolateModulesAsync` proves unreliable with native modules (`@discordjs/opus`, the davey addon), fall back to one worker per `worker_threads` thread with the fakes behind a message port; decide inside A3, not later.

**R6. Renewal recovery with two eligible workers.** `renewalRecoveryWorkerService.ts` reads due records and calls `reconcileRenewalRecovery` with no claim. What to do: D3 writes a test that runs two polls concurrently against one due record; if it double-charges or double-writes, add a conditional claim attribute on the renewal recovery record in the same task. Do not ship E2 without that result.

**R7. Stripe receipt schema may require the admission fields being removed.** `types/stripeWebhookReceipt.ts` stores `admission.runtime` and `generation`. What to do: D3 checks the schema; if the fields are required, keep writing them with the worker's `instanceId` and `release` rather than changing a billing schema.

**R8. The old runtime is still running during the first deployment.** New `WORKERS` items share its table. No `src` code scans DeploymentControlTable (verified), so it will not parse them. The deleted coordinator scripts do scan; nobody must run an old workflow revision after cutover. What to do: `docs/deployment.md` says so, and G2 deletes the workflows in the same change.

**R9. New alarm resources must fit a Terraform dispatch scope.** `terraform-dispatch.cjs` validates scopes and the scoped validators reject unexpected changes. What to do: G3 runs the plan validators locally against a plan containing `alerts-lifecycle.tf` and the role statements; if no scope admits them, add them to the processing-retry alarm scope's allow-list (`validate-processing-retry-plan.cjs`) rather than inventing a scope.

**R10. Health check and standby interact.** A standby worker (first deployment) is ready, so `/health` is 200 and ECS considers the deployment healthy while nothing is eligible yet. That is intended, but `wait-ready` in the workflow then succeeds before cutover. What to do: `docs/deployment.md` first-deployment steps tell the operator to stop the old task and confirm `"Worker eligible heartbeat"` in the logs; the `no_eligible_worker` alarm covers a forgotten step once applied.

**R11. Auto-record cancellation is not in the spec's outcome list** but exists today (`handleAutoRecordCancellation`, `resolveCompletionPolicy`). Dropping it would post notes for meetings that are cancelled today. What to do: both loaders report `cancel`, the pipeline writes `cancelled` and delivery edits the start message to the existing cancelled embed. Flag to the spec owner; no customer-visible change.
