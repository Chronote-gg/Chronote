# Meeting Processing Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner of a saved server meeting whose processing failed can re-run only the failed stages from the portal, and an operator can queue the same retry for every affected meeting in an incident window.

**Architecture:** Job state lives on the MeetingHistory row (`processingRetry` plus sparse `ProcessingRetryDueIndex` keys). A pure eligibility function feeds the portal payload, the request service and the operator script. An API-runtime worker, admitted under the existing `recovery` work domain, claims jobs with a renewed lease, re-runs stages with the existing transcript and generation code, and saves success through `updateMeeting` with a new `regeneration` mutation, so the existing delivery worker edits the Discord posts.

**Tech Stack:** TypeScript, DynamoDB conditional and transactional writes (mock store in tests), S3 `IfNoneMatch`, tRPC, React 19 + Mantine, Storybook, PostHog `captureEvent`, prom-client, Terraform, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-processing-retry-design.md` (ADR: `docs/adr-20261028-meeting-processing-retry.md`)

## Global Constraints

- Every new MeetingHistory field is optional. Existing rows are untouched until a retry is requested. Legacy rows without `processing` are never eligible.
- `meetings.processingRetry.enabled` defaults to `false` and gates both the portal action and the worker. Code must tolerate `ProcessingRetryDueIndex` not existing: the worker logs and idles, the mutation reports unavailable.
- User cap: 3 counted attempts per meeting, lifetime (no reset after success). Every attempt counts, operator ones included; only the cap check is bypassed for the operator.
- A job saves content only when every stage it re-ran succeeded. Failure writes only `processingRetry` and removes the queue keys.
- A retry never posts a fresh Discord message set; delivery goes through `updateMeeting`, which already holds `unpublished` and `held` meetings to portal-only.
- Analytics: exactly `guildId` and the acting user as `distinct_id`; properties are shape only. No privacy-policy change (AGENTS.md rule dated 2026-10-28).
- No em dashes in code, copy, docs or comments. Comments explain why. No `as`/`typeof` hedging on platform APIs. No new dependency.
- Quality ratchet: files at or above 1,000 lines may not grow, and no file may cross 1,000. Current sizes that bind this plan: `src/trpc/routers/meetings.ts` 1672, `src/db.ts` 4284, `src/services/personalMediaUploadProcessingService.ts` 1446, `src/frontend/pages/library/components/MeetingDetailDrawer.tsx` 1334, `test/trpc/meetingsRouter.test.ts` 1282 (frozen); `src/types/meetingUpdateDelivery.ts` 991, `src/config/registry.ts` 951 (must stay under 1,000); `test/repositories/meetingUpdateDeliveryContract.ts` 804 (add tests elsewhere). No touched function above 15 cyclomatic or cognitive; no new 8-line/50-token duplicate.
- Single-file test runs need `--coverage=false`.

## Review Focus

- A deploy handoff after the retry transcript is uploaded must not make the re-claimed job fail on its own object: the re-claim reuses `transcript-retry-<jobId>.json`. Pinned in Task 5.
- A notes edit landing while a job runs must end in `notes_changed` with no content write and no Discord change. Pinned in Tasks 3 and 6.
- Checkpoint `omitted` spans mix provider failures with speech-gate rejections (`recordingContentService.ts:263-268`); a re-transcribed span that the gate skips again must count as handled, not as a failure. Pinned in Task 2.
- A row with `notesVersion` above 1 but missing history entries (legacy) must count as human-edited. Pinned in Task 1.
- Flag off or index missing: the meeting page still loads, the worker never throws, the request answers unavailable. Pinned in Tasks 4, 6 and 7.

## File Structure

- `src/types/meetingProcessingRetry.ts` (new): queue constants, job schema, stage, status, failure and ineligibility enums, portal view type.
- `src/services/processingRetryEligibility.ts` (new): `getProcessingRetryEligibility`, `notesEditedByPerson`, `projectProcessingRetry`.
- `src/services/meetingRecoveryContent.ts`: shared transcript composition, new `retranscribeOmittedRanges`.
- `src/services/processingRetryTranscript.ts` (new): mixed-audio transcription, retry transcript key and idempotent store, `UNATTRIBUTED_TRANSCRIPT_NOTICE`.
- `src/types/meetingUpdateDelivery.ts`, `src/types/meetingCanonicalContent.ts`, `src/repositories/meetingUpdateDeliveryState.ts`, `src/repositories/meetingUpdateDeliveryRepository.ts`, `src/services/meetingUpdateService.ts`: `regeneration` mutation and write. `meetingUpdateRender.ts` needs no change: rendering is driven by captured parts, and a regeneration requests the same parts a correction does.
- `src/repositories/processingRetryRepository.ts` (new): queue, list due, claim, renew, fail, scan (Dynamo and mock), binding and index status.
- `src/services/processingRetryAvailability.ts` (new), `src/services/processingRetryRequestService.ts` (new).
- `src/services/processingRetryNotesInput.ts` (new): current-settings notes input. `src/services/processingRetryStages.ts` (new): stage runner. `src/services/processingRetryWorkerService.ts` (new): worker.
- `src/trpc/routers/meetingEditPermissions.ts` (new, moved out of `meetings.ts`), `src/trpc/routers/meetingProcessingRetry.ts` (new).
- Frontend: `MeetingProcessingRetry.tsx` (+ story, test) new; `MeetingSummaryPanel.tsx`, `useMeetingDetail.ts`, `utils/meetingLibrary.ts`, `MeetingDetailDrawer.tsx` (net zero lines) modified; `hooks/useProcessingRetry.ts` new.
- `_infra/main.tf`, `_infra/alerts-processing-retry.tf` (new), `scripts/init-dynamodb.js`.
- `scripts/retry-meeting-processing.ts` (new).

---

### Task 1: Retry types, eligibility, and the admission check

The spec's order puts `NotesEditSource` in the save task; it moves here because the human-edit rule reads it.

**Files:**

- Create: `src/types/meetingProcessingRetry.ts`, `src/services/processingRetryEligibility.ts`
- Modify: `src/types/db.ts:168-176` (`NotesEditSource`), `:453-528` (`MeetingHistory`)
- Test: `test/services/processingRetryEligibility.test.ts`, `test/services/processingRetryAdmission.test.ts`

**Interfaces:**

- Produces in `meetingProcessingRetry.ts`: `PROCESSING_RETRY_QUEUE = "processing-retry:v1"`, `PROCESSING_RETRY_DUE_INDEX = "ProcessingRetryDueIndex"`, `PROCESSING_RETRY_USER_ATTEMPT_CAP = 3`; `processingRetryJobSchema` (strict zod) and `type ProcessingRetryJob = { jobId; status: "queued" | "running" | "succeeded" | "failed"; stages: ProcessingRetryStage[] (min 1); requestedBy; requestedAt (ISO); expectedNotesVersion (positive int); replaceNotes: boolean; countedAttempts (non-negative int); settingsSource: "snapshot" | "current"; transcriptSource: "checkpoint" | "mixed" | "existing"; failureReason?: ProcessingRetryFailureReason; claim?: { ownerInstanceId: string; leaseExpiresAt: number }; updatedAt (ISO) }`; `ProcessingRetryStage = "transcription" | "notes" | "summary"`; `ProcessingRetryFailureReason = "stage_failed" | "source_missing" | "notes_changed" | "invalid_snapshot" | "nothing_to_retry" | "unknown"`; `ProcessingRetryIneligibleReason = "unavailable" | "not_permitted" | "personal_meeting" | "processing_in_progress" | "no_processing_record" | "job_active" | "nothing_failed" | "capture_incomplete" | "source_missing" | "attempts_exhausted" | "notes_edited"`; `type ProcessingRetryEligibility = { eligible: true; stages: ProcessingRetryStage[]; requiresReplaceConfirm: boolean; transcriptSource: ProcessingRetryJob["transcriptSource"] } | { eligible: false; reason: ProcessingRetryIneligibleReason }`; `type ProcessingRetryView = { eligible: boolean; reason?: ProcessingRetryIneligibleReason; requiresReplaceConfirm: boolean; status?: ProcessingRetryJob["status"]; failureReason?: ProcessingRetryFailureReason; settingsSource?: ProcessingRetryJob["settingsSource"]; attemptsRemaining: number }`. The frontend imports these with `import type` only.
- Produces in `db.ts`: `NotesEditSource` gains `| { type: "processing_retry"; jobId: string }`; `MeetingHistory` gains `processingRetry?: ProcessingRetryJob; processingRetryQueue?: typeof PROCESSING_RETRY_QUEUE; processingRetryDueAt?: number`.
- Produces in `processingRetryEligibility.ts`: `getProcessingRetryEligibility(history: MeetingHistory, actor: "portal" | "operator" = "portal"): ProcessingRetryEligibility`, `notesEditedByPerson(history: Pick<MeetingHistory, "notesVersion" | "notesHistory">): boolean`, `projectProcessingRetry(history: MeetingHistory, blocked?: "unavailable" | "not_permitted"): ProcessingRetryView`.

Rules `getProcessingRetryEligibility` applies, in this order (each failing check returns its reason):

1. `isPersonalMeeting(history)` -> `personal_meeting`.
2. `originalPublicationUnsettled(publicationSnapshot(history))` (active, processing, or owned by interrupted-recording recovery) -> `processing_in_progress`.
3. no `processing` -> `no_processing_record`.
4. `processingRetry.status` is `queued` or `running` -> `job_active`.
5. Stages, with "usable transcript" meaning `transcriptS3Key` set and transcription `ready` or `partial`: transcription `failed` or no usable transcript while notes or summary failed -> all three; transcription `partial` -> all three, unless `processingRetry?.status === "succeeded"` or `processingRetry?.failureReason === "nothing_to_retry"` (the row cannot tell an ASR `partial` from a capture `partial`, so the first retry finds out; an interrupted capture can still hold ASR failures, so `capture.kind` is not a stand-in); `notes: failed` -> notes, summary; `summary: failed` only -> summary. Nothing selected -> `capture_incomplete` when the only remaining defect is such a `partial`, else `nothing_failed`.
6. Inputs: transcription needs `checkpoint` or `audioS3Key`; summary-only needs non-empty `notes` -> else `source_missing`. `transcriptSource` is `checkpoint`, `mixed`, or `existing` when transcription is not re-run.
7. `actor === "portal"` and `countedAttempts >= 3` -> `attempts_exhausted`.
8. Stages include notes and `notes?.trim()`: `notesEditedByPerson` -> `notes_edited` (for both actors); otherwise `requiresReplaceConfirm: true`.

`notesEditedByPerson` is false when `notesVersion` is absent or 1; otherwise true unless every version 2..`notesVersion` has a `notesHistory` entry with `source.type === "processing_retry"` (an entry with no `source`, or a missing entry, counts as a person).

- [ ] **Step 1: Write the failing eligibility tests.** Base row: `history()` from `test/types/meetingUpdateDelivery.fixture.ts` plus `status: "complete"`, `transcriptS3Key: "t/transcript.json"`, `audioS3Key: "t/audio.mp3"`.

```ts
test.each([
  [
    "transcription failed with checkpoint",
    {
      processing: {
        transcription: "failed",
        notes: "skipped",
        summary: "skipped",
      },
      checkpoint: pointer,
    },
    ["transcription", "notes", "summary"],
    "checkpoint",
  ],
  [
    "transcription failed without checkpoint",
    { processing: { transcription: "failed", notes: "skipped" } },
    ["transcription", "notes", "summary"],
    "mixed",
  ],
  [
    "notes failed",
    {
      processing: {
        transcription: "ready",
        notes: "failed",
        summary: "skipped",
      },
      notes: undefined,
    },
    ["notes", "summary"],
    "existing",
  ],
  [
    "summary failed only",
    {
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
    },
    ["summary"],
    "existing",
  ],
])("%s selects its stages", (_, patch, stages, transcriptSource) => {
  expect(getProcessingRetryEligibility({ ...base, ...patch })).toEqual({
    eligible: true,
    stages,
    transcriptSource,
    requiresReplaceConfirm: false,
  });
});
test("partial transcript with generated notes requires replace confirmation", () => {
  expect(
    getProcessingRetryEligibility({
      ...base,
      processing: {
        transcription: "partial",
        notes: "generated",
        summary: "generated",
      },
    }),
  ).toMatchObject({ eligible: true, requiresReplaceConfirm: true });
});
test.each([
  ["personal_meeting", { ownershipScope: "personal" }],
  ["processing_in_progress", { status: "processing" }],
  ["no_processing_record", { processing: undefined }],
  [
    "nothing_failed",
    { processing: { transcription: "empty", notes: "skipped" } },
  ],
  [
    "job_active",
    { processing: failedNotes, processingRetry: job({ status: "queued" }) },
  ],
  [
    "capture_incomplete",
    {
      processing: partialNotes,
      processingRetry: job({
        status: "failed",
        failureReason: "nothing_to_retry",
      }),
    },
  ],
  [
    "capture_incomplete",
    { processing: partialNotes, processingRetry: job({ status: "succeeded" }) },
  ],
  [
    "source_missing",
    { processing: { transcription: "failed" }, audioS3Key: undefined },
  ],
  [
    "source_missing",
    {
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
      notes: " ",
    },
  ],
  [
    "attempts_exhausted",
    {
      processing: failedNotes,
      processingRetry: job({ status: "failed", countedAttempts: 3 }),
    },
  ],
  [
    "notes_edited",
    {
      processing: partialNotes,
      notesVersion: 2,
      notesHistory: [
        {
          version: 2,
          notes: "x",
          editedBy: "u",
          editedAt: iso,
          source: { type: "web_editor" },
        },
      ],
    },
  ],
])("is not eligible: %s", (reason, patch) => {
  expect(getProcessingRetryEligibility({ ...base, ...patch })).toEqual({
    eligible: false,
    reason,
  });
});
test("the operator bypasses only the attempt cap", () => {
  const exhausted = {
    ...base,
    processing: failedNotes,
    processingRetry: job({ status: "failed", countedAttempts: 3 }),
  };
  expect(getProcessingRetryEligibility(exhausted, "operator")).toMatchObject({
    eligible: true,
  });
  const edited = {
    ...base,
    processing: partialNotes,
    notesVersion: 2,
    notesHistory: [{ version: 2, notes: "x", editedBy: "u", editedAt: iso }],
  };
  expect(getProcessingRetryEligibility(edited, "operator")).toEqual({
    eligible: false,
    reason: "notes_edited",
  });
});
test.each([
  [undefined, [], false],
  [1, [], false],
  [
    2,
    [{ version: 2, source: { type: "processing_retry", jobId: "j" } }],
    false,
  ],
  [2, [{ version: 2 }], true],
  [2, [{ version: 2, source: { type: "web_editor" } }], true],
  [3, [{ version: 3, source: { type: "processing_retry", jobId: "j" } }], true],
])(
  "notesVersion %p with history %j is person-edited: %p",
  (notesVersion, entries, expected) => {
    expect(
      notesEditedByPerson({
        notesVersion,
        notesHistory: entries.map((e) => ({
          notes: "n",
          editedBy: "u",
          editedAt: iso,
          ...e,
        })),
      }),
    ).toBe(expected);
  },
);
test("projection reports remaining attempts and an external block", () => {
  const row = {
    ...base,
    processing: failedNotes,
    processingRetry: job({
      status: "failed",
      failureReason: "stage_failed",
      countedAttempts: 2,
      settingsSource: "current",
    }),
  };
  expect(projectProcessingRetry(row)).toEqual({
    eligible: true,
    requiresReplaceConfirm: false,
    status: "failed",
    failureReason: "stage_failed",
    settingsSource: "current",
    attemptsRemaining: 1,
  });
  expect(projectProcessingRetry(row, "unavailable")).toMatchObject({
    eligible: false,
    reason: "unavailable",
  });
});
```

(`failedNotes = { transcription: "ready", notes: "failed", summary: "skipped" }`, `partialNotes = { transcription: "partial", notes: "generated", summary: "generated" }`, `job()` builds a valid `ProcessingRetryJob`, `pointer` is any object, since eligibility only checks presence.)

- [ ] **Step 2: Write the admission test** in `test/services/processingRetryAdmission.test.ts`: mock `activeMeetingLeaseService` (`getOwnedSessionReservations: () => []`, as in `test/services/meetingRecoveryShutdown.test.ts:7-10`) and `runtimeLifecycleService` (`beginRuntimeWork: jest.fn(() => ({ transition, settle: jest.fn() }))`).

```ts
test("recovery work is admitted without an ActiveMeeting lease and counts as recovery processing", async () => {
  const work = beginRuntimeWorkClaim("recovery", "processing-retry:g:c");
  work.claimed();
  expect(transition).toHaveBeenCalledWith("recovery_processing");
  await work.settle();
  expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
});
```

If this test can only pass by passing a `session` argument (an ActiveMeeting lease), stop and ask BASIC; do not add a work kind. Reading `runtimeWorkAdmissionService.ts:59-93` shows a lease is required only when `session` is given.

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test test/services/processingRetryEligibility.test.ts test/services/processingRetryAdmission.test.ts --coverage=false`
Expected: eligibility FAILS (module missing); admission PASSES.

- [ ] **Step 4: Implement the types, `db.ts` fields and the three functions.** Split stage selection and reason checks into small helpers to stay under complexity 15.

- [ ] **Step 5: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 6: Commit** `feat: add processing retry eligibility and job types`

---

### Task 2: Re-transcription from checkpoint ranges or mixed audio

**Files:**

- Modify: `src/services/meetingRecoveryContent.ts:346-378` (`transcribeAudioGroup`), `:379-432` (`recoverAudioIntervals`), `:464-561` (`recoverTranscript`)
- Modify: `src/services/personalMediaUploadProcessingService.ts:158` (`export` keyword on `runFfmpeg`, no line change)
- Create: `src/services/processingRetryTranscript.ts`
- Test: `test/services/processingRetryTranscript.test.ts`

**Interfaces:**

- Produces: `export async function retranscribeOmittedRanges(content: RecoveryContent, reader: RecoveryReader, signal: AbortSignal, effect: TranscriptionContentInput["effect"]): Promise<{ text: string; segments: TranscriptSegment[]; retranscribedRanges: number }>`. `retranscribedRanges` counts the groups it sent for transcription (0 means the checkpoint had nothing to redo). Keeps every saved `entries` item (and its speaker), ignores `processing.finalText`, and re-transcribes the PCM not covered by a represented entry, which is exactly the `omitted` spans plus never-transcribed audio. A group result of `skipped` counts as handled; `failed` throws `Error("Recovery transcription failed")`. `InvalidRecoveryContent` and `TranscriptOverlapUnknown` propagate as today.
- Shared refactor: lines 492-560 of `recoverTranscript` become a private `composeRecoveredTranscript(content, reader, signal, effect, covered: PcmSpan[], acceptSkipped: boolean)`; `recoverTranscript` passes `dispositions` and `false` (behavior unchanged), `retranscribeOmittedRanges` passes the represented spans and `true`. `transcribeAudioGroup` and `recoverAudioIntervals` gain `acceptSkipped: boolean`.
- Produces in `processingRetryTranscript.ts`: `UNATTRIBUTED_TRANSCRIPT_NOTICE` with the exact text from `scripts/recover-outage-meeting-notes.ts:63-64` on `origin/claude/outage-meeting-recovery` (it does not exist on master); `transcribeMixedRecording(audioS3Key: string, signal: AbortSignal): Promise<{ text: string } | "source_missing">` (temp dir via `ensureTempBaseDir`, `downloadObjectToFile` false -> `"source_missing"`, `runFfmpeg`, `resolveTranscriptionInputs`, `transcribeAudioFiles(chunks, false, signal)` so any chunk failure throws; automatic language detection is already the default since #476; temp dir removed in `finally`); `retryTranscriptKey(history: Pick<MeetingHistory, "checkpoint" | "audioS3Key" | "transcriptS3Key">, jobId: string): string` = `<folder>transcript-retry-<jobId>.json`, folder being `checkpoint.artifactFolder`, else the prefix through the last `/` of `audioS3Key`, else of `transcriptS3Key`; `storeRetryTranscript(key: string, payload: TranscriptPayload, signal: AbortSignal): Promise<void>` (`uploadObjectToS3(key, JSON.stringify(payload), "application/json", { immutable: true, signal })`; when that returns `undefined`, read back with `fetchJsonFromS3` and succeed only if `stableJson` matches, else throw).
- `splitAudioFile` stays private: `resolveTranscriptionInputs` and `transcribeAudioFiles` are already exported on master.

- [ ] **Step 1: Write the failing tests.** Checkpoint tests use `recoveryFixture` from `test/services/meetingRecoveryFixtures.ts` with a two-source PCM artifact as in `test/services/meetingRecoveryService.test.ts:660-700`, and mock `transcribeContentSnippet` as in that file's header.

```ts
test("re-transcribes only omitted ranges, keeps saved entries, and stays attributed", async () => {
  // entry for user:123 covers bytes 0-1920 of sequence 0; omitted covers 1920-3840; processing.finalText is set
  const result = await retranscribeOmittedRanges(
    content,
    f.reader,
    signal,
    run,
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  expect(result.segments.map((s) => [s.userId, s.text])).toEqual([
    ["123", "Saved words."],
    ["123", "Recovered words."],
  ]);
  expect(result.text).not.toContain("Exact finalized input");
});
test("a range the speech gate skips again counts as handled", async () => {
  jest
    .mocked(transcribeContentSnippet)
    .mockResolvedValueOnce({
      status: "skipped",
      reason: "non_speech",
      coverage,
    });
  await expect(
    retranscribeOmittedRanges(content, f.reader, signal, run),
  ).resolves.toMatchObject({ segments: [{ text: "Saved words." }] });
});
test("a provider failure on any range fails the transcription", async () => {
  jest
    .mocked(transcribeContentSnippet)
    .mockResolvedValueOnce({ status: "failed", reason: "transcription_error" });
  await expect(
    retranscribeOmittedRanges(content, f.reader, signal, run),
  ).rejects.toThrow("Recovery transcription failed");
});
test("recoverTranscript still refuses an acknowledged transcript with uncovered input", async () => {
  await expect(
    recoverTranscript(content, f.reader, signal, run),
  ).rejects.toBeInstanceOf(TranscriptOverlapUnknown);
});
test("mixed recording transcription reports a missing object as source_missing", async () => {
  jest.mocked(downloadObjectToFile).mockResolvedValueOnce(false);
  await expect(
    transcribeMixedRecording("g/c_m_t/audio.mp3", signal),
  ).resolves.toBe("source_missing");
});
test("mixed recording transcription fails on any failed chunk", async () => {
  jest.mocked(transcribeAudioFiles).mockRejectedValueOnce(new Error("429"));
  await expect(
    transcribeMixedRecording("g/c_m_t/audio.mp3", signal),
  ).rejects.toThrow("429");
});
test.each([
  [
    { checkpoint: { artifactFolder: "p/g/c_m_t/" } },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
  [
    { audioS3Key: "p/g/c_m_t/audio.mp3" },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
])("retry transcript key for %j", (row, key) =>
  expect(retryTranscriptKey(row, "job-1")).toBe(key),
);
test("storing the same transcript twice succeeds; a different body at the key throws", async () => {
  await storeRetryTranscript(key, payload, signal);
  await expect(
    storeRetryTranscript(key, payload, signal),
  ).resolves.toBeUndefined();
  await expect(
    storeRetryTranscript(key, { ...payload, text: "other" }, signal),
  ).rejects.toThrow();
});
```

(Mixed tests mock `storageService.downloadObjectToFile` and the three `personalMediaUploadProcessingService` exports; store tests run on the mock store, where `immutable` already refuses an existing key.)

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/services/processingRetryTranscript.test.ts --coverage=false`
Expected: FAIL (`retranscribeOmittedRanges is not a function`).

- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the new file plus `test/services/meetingRecoveryService.test.ts`. Expected: PASS, recovery tests unchanged.
- [ ] **Step 5: Commit** `feat: re-transcribe failed ranges and mixed audio for processing retry`

---

### Task 3: The `regeneration` save path

**Files:**

- Modify: `src/types/meetingUpdateDelivery.ts:64-129` (keep the file under 1,000 lines)
- Modify: `src/types/meetingCanonicalContent.ts:55-75`
- Modify: `src/repositories/meetingUpdateDeliveryState.ts:128-200` (`canCompareContentWrite`, `prepareContentWrite`)
- Modify: `src/repositories/meetingUpdateDeliveryRepository.ts:72-87` (`MeetingContentWrite`), `:299-318` (`changedFields`), `:405-421` (old-value conditions)
- Modify: `src/services/meetingUpdateService.ts:28-35, 86-113`
- Create: `test/repositories/meetingRegenerationContract.ts`
- Modify tests: `test/repositories/meetingUpdateDeliveryRepository.test.ts` and `test/deployment/meetingUpdateDelivery.integration.test.ts` (one call each to `regenerationContract`), `test/services/meetingUpdateService.test.ts`

**Interfaces:**

- Consumes: `ProcessingRetryJob` (Task 1).
- Produces: mutation `{ kind: "regeneration"; changes: ContentChange[] }`. Extract the correction's `changes` array schema (`min(1).max(4)`, unique kinds) into one `contentChanges` const used by both kinds. `requestedPartsForMutation` handles `"regeneration"` in the `"correction"` case. `nextCanonicalFieldRevisions` excludes both kinds from the single-change union; `prepareContentWrite` uses `"changes" in mutation`.
- Produces: `MeetingContentWrite.regeneration?: { expected: { jobId: string; ownerInstanceId: string; expectedNotesVersion: number }; processing: MeetingProcessingOutcome; transcriptS3Key?: string; job: ProcessingRetryJob }`, and the same optional field on `MeetingUpdateActionInput`, copied into the write.
- `canCompareContentWrite` additionally requires, when `regeneration` is set, `row.processingRetry` with that `jobId`, `status === "running"`, that `claim.ownerInstanceId`, and `notesVersion === expectedNotesVersion`. `updateMeeting` returns `conflict` early on that version mismatch.
- `prepareContentWrite` throws unless `mutation.kind === "regeneration"` exactly when `input.regeneration` is set, then sets `processing`, `transcriptS3Key` (when given), `processingRetry = job`, and removes `processingRetryQueue` and `processingRetryDueAt`. Notes changes keep the existing `notesEdit` audit; the caller passes `source: { type: "processing_retry", jobId }`.
- `changedFields` gains `processing`, `transcriptS3Key`, `processingRetry`, `processingRetryQueue`, `processingRetryDueAt`. `processingRetry` joins the fields whose old value becomes a write condition, so the stored job and claim must be byte-for-byte what the worker read. This is the extra claim condition. `processing` is already conditioned through the publication snapshot.

- [ ] **Step 1: Write the failing contract** `regenerationContract(make: () => Harness)` in `test/repositories/meetingRegenerationContract.ts` (`Harness` and `write` from `meetingUpdateDeliveryContract.ts`). Seed: `history()` plus `pointers`, `contentRevision: 1`, `notesVersion: 1`, `updateDelivery: pending()`, `processing: { transcription: "ready", notes: "failed", summary: "skipped" }`, `processingRetry: running` (`status: "running"`, `claim: { ownerInstanceId: "instance-a", leaseExpiresAt: now + 300 }`), `processingRetryQueue`, `processingRetryDueAt`.

```ts
it("regeneration saves notes, summary, processing, transcript key and the terminal job in one write", async () => {
  await h.seed(row);
  expect(
    await h.repository.updateContentAndDelivery(
      regenerationWrite(row),
      undefined,
    ),
  ).toMatchObject({ kind: "committed" });
  const saved = await h.read();
  expect(saved).toMatchObject({
    notes: "Regenerated notes",
    notesVersion: 2,
    summarySentence: "S",
    summaryLabel: "L",
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    transcriptS3Key: "f/transcript-retry-job-1.json",
    processingRetry: {
      jobId: "job-1",
      status: "succeeded",
      countedAttempts: 1,
    },
  });
  expect(saved?.notesHistory?.at(-1)).toMatchObject({
    version: 2,
    editedBy: "requester",
    source: { type: "processing_retry", jobId: "job-1" },
  });
  expect(saved).not.toHaveProperty("processingRetryQueue");
  expect(saved).not.toHaveProperty("processingRetryDueAt");
  expect(saved?.updateDelivery?.parts.notesBody.desired).toBe(2);
});
it.each([
  ["another job", { jobId: "job-2" }],
  [
    "another owner",
    { claim: { ownerInstanceId: "instance-b", leaseExpiresAt: now + 300 } },
  ],
  ["a queued job", { status: "queued" }],
])("regeneration conflicts when the stored job is %s", async (_, patch) => {
  await h.seed({ ...row, processingRetry: { ...running, ...patch } });
  expect(
    await h.repository.updateContentAndDelivery(
      regenerationWrite(row),
      undefined,
    ),
  ).toEqual({ kind: "conflict" });
});
it("regeneration conflicts when notes moved past the job's expected version", async () => {
  await h.seed({ ...row, notesVersion: 2 });
  expect(
    await h.repository.updateContentAndDelivery(
      regenerationWrite(row),
      undefined,
    ),
  ).toEqual({ kind: "conflict" });
});
it("summary-only regeneration keeps the notes version and history", async () => {
  await h.seed(row);
  await h.repository.updateContentAndDelivery(
    regenerationWrite(row, { notes: undefined }),
    undefined,
  );
  expect(await h.read()).toMatchObject({
    notesVersion: 1,
    notesHistory: undefined,
    summaryLabel: "L",
  });
});
it("regeneration on an unpublished meeting saves without queueing delivery", async () => {
  const unpublished = {
    ...row,
    notesChannelId: undefined,
    notesMessageIds: undefined,
    updateDelivery: undefined,
  };
  await h.seed(unpublished);
  await h.repository.updateContentAndDelivery(
    regenerationWrite(unpublished, { policy: { kind: "unpublished" } }),
    undefined,
  );
  expect(await h.read()).not.toHaveProperty("updateDeliveryQueue");
});
it("a retried identical regeneration write is recognized as already applied", async () => {
  await h.seed(row);
  const input = regenerationWrite(row);
  await h.repository.updateContentAndDelivery(input, undefined);
  expect(
    await h.repository.updateContentAndDelivery(input, undefined),
  ).toMatchObject({ kind: "committed" });
});
it("regeneration requires matching mutation and payload", async () => {
  await h.seed(row);
  await expect(
    h.repository.updateContentAndDelivery(
      { ...regenerationWrite(row), regeneration: undefined },
      undefined,
    ),
  ).rejects.toThrow();
});
```

`regenerationWrite(row, options?)` builds the write the way `write()` does, with `mutation: { kind: "regeneration", changes }`, `notesEdit` only when notes are present, and `regeneration: { expected: { jobId: "job-1", ownerInstanceId: "instance-a", expectedNotesVersion: 1 }, processing, transcriptS3Key, job: { ...running, status: "succeeded", countedAttempts: 1, claim: undefined } }`.

In `test/services/meetingUpdateService.test.ts`:

```ts
test("regeneration commits through updateMeeting and syncs Notion once", async () => {
  // seed as above; call updateMeeting({ key, mutation, actor: { editedBy: "requester" }, notesEdit: { expectedNotesVersion: 1, source: { type: "processing_retry", jobId: "job-1" } }, regeneration })
  expect(result.kind).toBe("saved");
  expect(maybeAutoSyncMeetingNotes).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/repositories/meetingUpdateDeliveryRepository.test.ts test/services/meetingUpdateService.test.ts --coverage=false`
Expected: FAIL (schema rejects `regeneration`).

- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the step 2 command plus `test/repositories test/types test/services/meetingUpdate*`. Expected: PASS. With `DEPLOYMENT_TEST_DYNAMODB_ENDPOINT` set, also run `yarn test test/deployment/meetingUpdateDelivery.integration.test.ts --coverage=false` so the Dynamo condition is exercised (otherwise CI runs it).
- [ ] **Step 5: Commit** `feat: save processing retry results through updateMeeting`

---

### Task 4: Queue repository, flag, and request service

**Files:**

- Create: `src/repositories/processingRetryRepository.ts`, `src/services/processingRetryAvailability.ts`, `src/services/processingRetryRequestService.ts`
- Modify: `src/db.ts:151, 210` (`export` on `dynamoDbClient` and `controlTableNames`; no added lines), `src/config/keys.ts:58-63`, `src/config/registry.ts` (entry after `meetings.artifacts.audioAccess.enabled`), `src/metrics.ts`, `src/constants.ts`
- Test: `test/repositories/processingRetryRepository.test.ts`, `test/services/processingRetryRequest.test.ts`

**Interfaces:**

- Produces `ProcessingRetryRepository` with `queue(input: { key: MeetingUpdateKey; expected: Pick<MeetingHistory, "processing" | "notesVersion" | "processingRetry">; job: ProcessingRetryJob; dueAt: number }): Promise<"queued" | "conflict">`, `listDue(input: { now: number; limit: number; signal?: AbortSignal }): Promise<MeetingUpdateKey[]>`, `claim(input: { key; jobId: string; ownerInstanceId: string; now: number; leaseExpiresAt: number; authority: WorkAdmissionAuthority; signal?: AbortSignal }): Promise<ProcessingRetryJob | undefined>`, `renew(input: { key; jobId; ownerInstanceId; leaseExpiresAt: number }): Promise<boolean>`, `fail(input: { key; expected: ProcessingRetryJob; failed: ProcessingRetryJob }): Promise<"applied" | "stale">`, `scan(input: { from: string; to: string; guildId?: string; cursor?: string }): Promise<{ rows: MeetingHistory[]; cursor?: string }>`. Factories `createDynamoProcessingRetryRepository(client, tables: ControlTableNames)` and `createMockProcessingRetryRepository(histories, admit)` share pure row checks; `getProcessingRetryRepository()` binds mock or Dynamo like `bindMeetingUpdateDeliveryRepository`; `getProcessingRetryIndexStatus()` calls `readDynamoIndexStatus` for `PROCESSING_RETRY_DUE_INDEX`.
- Write rules. `queue`: row exists, `processing` and `notesVersion` (or its absence) equal `expected`, and `processingRetry` is absent or equals `expected.processingRetry` with a terminal status; sets `processingRetry`, `processingRetryQueue`, `processingRetryDueAt = dueAt`. `claim`: transactional with `buildWorkAdmissionChecks(authority, tables)` (as in the delivery `claim`); allowed when the stored job has `jobId` and is `queued`, or `running` with `claim.leaseExpiresAt <= now`; sets `status: "running"`, `claim`, `processingRetryDueAt = leaseExpiresAt`, so an abandoned job reappears in the index when its lease lapses. `renew` and `fail` condition on `jobId` and `claim.ownerInstanceId`; `renew` moves `leaseExpiresAt` and `processingRetryDueAt`; `fail` sets the failed job and removes both queue keys. `listDue` queries `processingRetryQueue = :queue AND processingRetryDueAt <= :now` with `Limit`. `scan` filters `#timestamp BETWEEN :from AND :to AND attribute_exists(processing)` (plus `guildId = :guild`), paginated.
- Produces `isProcessingRetryEnabled(): Promise<boolean>` (`resolveConfigSnapshot({})` then `getSnapshotBoolean(snapshot, CONFIG_KEYS.meetings.processingRetryEnabled)`) and `isProcessingRetryAvailable(): Promise<boolean>` (enabled and index status `ACTIVE`; a describe error counts as unavailable).
- Config: `CONFIG_KEYS.meetings.processingRetryEnabled = "meetings.processingRetry.enabled"`; registry entry with category `"Meetings"`, group `"Experimental"`, `valueType: "boolean"`, `defaultValue: false`, `scopes: { global: scope(true, true, "superadmin", "toggle") }`, `ui: { type: "toggle" }`, and a description saying it stays off until `ProcessingRetryDueIndex` is active.
- Metrics: `processingRetryJobs = new Counter({ name: "meeting_processing_retry_jobs_total", help, labelNames: ["outcome", "reason"] as const })` with outcome `queued | succeeded | failed` and reason a failure reason or `"none"`.
- Constants: `PROCESSING_RETRY_POLL_INTERVAL_MS = 5_000`, `PROCESSING_RETRY_MAX_CONCURRENT = 2`, `PROCESSING_RETRY_CLAIM_SECONDS = 300`, `PROCESSING_RETRY_CLAIM_RENEWAL_MS = 120_000`, `PROCESSING_RETRY_SAVE_ATTEMPTS = 3` (the lease values mirror the personal upload worker).
- Produces `requestProcessingRetry(input: { key: MeetingUpdateKey; requestedBy: string; replaceNotes: boolean; source: "portal" | "operator" }): Promise<{ kind: "queued"; history: MeetingHistory; job: ProcessingRetryJob } | { kind: "unavailable" } | { kind: "ineligible"; reason: ProcessingRetryIneligibleReason | "replace_confirmation_required" } | { kind: "conflict" }>`. It checks availability, strongly reads the row, runs eligibility with `actor = source === "operator" ? "operator" : "portal"`, requires `replaceNotes` when `requiresReplaceConfirm`, then queues `{ jobId: randomUUID(), status: "queued", stages, requestedBy, requestedAt, expectedNotesVersion: readMeetingUpdateRevisions(row).notesVersion, replaceNotes, countedAttempts: row.processingRetry?.countedAttempts ?? 0, settingsSource: row.checkpoint ? "snapshot" : "current", transcriptSource, updatedAt }` (the worker overwrites `settingsSource` with what it actually used). On `queued` it increments the counter and calls `captureEvent("meeting_processing_retry_requested", { userId: requestedBy, guildId, properties: { stages, source, replace_notes: replaceNotes, settings_source } })`.

- [ ] **Step 1: Write the failing repository tests** (mock factory over a `Map`, same harness shape as `meetingUpdateDeliveryRepository.test.ts`): "queues only when processing, notes version and the previous terminal job match"; "a second queue for the same meeting conflicts"; "claim admits a queued job and a running job whose lease lapsed, never a live lease"; "claim is refused without work admission"; "renew and fail require the same job and owner"; "fail removes the queue keys and leaves content untouched" (`notes`, `processing`, `contentRevision` deep-equal before and after); "listDue returns only due queued keys"; "scan filters by window and guild".
- [ ] **Step 2: Write the failing request tests.** Mock `processingRetryAvailability` and `analyticsService`, seed `getMockStore().meetingHistoryByGuild`.

- "queues a failed meeting with the captured notes version and predicted sources": result `{ kind: "queued", job: { status: "queued", stages: ["notes", "summary"], expectedNotesVersion: 1, countedAttempts: 0, settingsSource: "current", transcriptSource: "existing" } }`; row has `processingRetryQueue: "processing-retry:v1"` and a numeric `processingRetryDueAt`.
- "two simultaneous requests queue exactly one job": `Promise.all` of two requests yields one `queued`.
- "replacing generated notes needs replaceNotes": on a `partial` row, `replaceNotes: false` gives `{ kind: "ineligible", reason: "replace_confirmation_required" }`; `true` queues with `job.replaceNotes === true`.
- "users stop at three counted attempts; the operator does not": with a failed job at `countedAttempts: 3`, portal gives `attempts_exhausted`, operator queues with `countedAttempts: 3`.
- "reports unavailable while the flag or index is off, and writes nothing": `{ kind: "unavailable" }` and no `processingRetry` on the row.
- "captures the requested event with shape-only properties": `captureEvent("meeting_processing_retry_requested", { userId: "111111111111111111", guildId, properties: { stages: ["notes", "summary"], source: "portal", replace_notes: false, settings_source: "current" } })`.

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test test/repositories/processingRetryRepository.test.ts test/services/processingRetryRequest.test.ts --coverage=false`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement** as in Interfaces. `src/db.ts` must keep 4284 lines.
- [ ] **Step 5: Run** the step 3 command plus `test/config`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: queue processing retries on the meeting row`

---

### Task 5: Stage runner and current-settings notes input

**Files:**

- Create: `src/services/processingRetryNotesInput.ts`, `src/services/processingRetryStages.ts`
- Modify: `src/services/notesPromptService.ts:390-397` and `src/services/meetingRecoveryContent.ts:582-587` (shared chat variables)
- Test: `test/services/processingRetryStages.test.ts`, `test/services/processingRetryNotesInput.test.ts`

**Interfaces:**

- Consumes: Task 2 functions, `readRecoveryContent`, `recoveryNotesInput`, `InvalidRecoveryContent`, `TranscriptOverlapUnknown`, `ensureMeetingNotes`, `ensureMeetingSummaries`.
- Produces in `notesPromptService.ts`: `chatContextVariables(chatContext: string | undefined): { chatContextInstruction: string; chatContextBlock: string }`, used by `prepareLiveNotesPrompt`, `recoveryNotesInput` and the new builder. This removes the copy the two existing call sites already share.
- Produces `buildCurrentNotesInput(history: MeetingHistory, transcript: string, signal: AbortSignal): Promise<MeetingNotesInput>`, a port of the dry-run assembly in `scripts/recover-outage-meeting-notes.ts` (`dryRun` and `buildFormattedContext`, branch `origin/claude/outage-meeting-recovery`) that reads Discord through `listBotGuildsCached`, `listGuildChannelsCached` and `listGuildRolesCached` instead of REST with a bot token. Keep the script's rule that only meetings before `history.timestamp` feed memory. Prompt `config.langfuse.notesPromptName`; `promptVisibleRoleIds` from `selectRolesForPrompt`; `participants` from `history.participants`; `creator: { id: history.meetingCreatorId }`; `meetingName: history.meetingName`; `startTime: new Date(history.timestamp)`. A Langfuse fetch failure throws (no invented prompt).
- Produces `clearRetriedStages(input: MeetingNotesInput, history: MeetingHistory, stages: ProcessingRetryStage[], transcription?: TranscriptionOutcome): void`. Removes the `processing` outcome of every retried stage; with notes retried, deletes `notesText`; with summary retried, deletes `summarySentence` and `summaryLabel`; sets `processing.transcription` to `transcription` when re-transcribed, else to `history.processing.transcription` (`recoveryNotesInput` recomputes it from the checkpoint otherwise); for summary only, keeps `processing.notes` and `notesText = history.notes`.
- Produces `runProcessingRetryStages(input: { history: MeetingHistory; job: ProcessingRetryJob; signal: AbortSignal; effect: TranscriptionContentInput["effect"]; reader: RecoveryReader }): Promise<ProcessingRetryRun>` where `ProcessingRetryRun = { kind: "succeeded"; changes: { processing: MeetingProcessingOutcome; notes?: string; summarySentence?: string; summaryLabel?: string; meetingName?: string; transcriptS3Key?: string }; settingsSource; transcriptSource } | { kind: "failed"; reason: ProcessingRetryFailureReason; settingsSource; transcriptSource }`.

Runner order:

1. If `transcription` is retried: if `retryTranscriptKey(history, job.jobId)` already holds a payload (`fetchJsonFromS3`), reuse it, since a previous claimant of this job finished it. Otherwise, with a checkpoint, run `readRecoveryContent` then `retranscribeOmittedRanges`; `retranscribedRanges === 0` fails `nothing_to_retry` before any notes work. On `InvalidRecoveryContent` or `TranscriptOverlapUnknown`, fall back to mixed audio when `audioS3Key` exists, else fail `invalid_snapshot`. Without a checkpoint, run `transcribeMixedRecording` (`"source_missing"` fails `source_missing`). A thrown provider error fails `stage_failed`. Store `{ generatedAt, segments, text }` with `storeRetryTranscript`. The outcome is `"partial"` when the capture was interrupted, checkpoint artifacts are missing, or `context.captureIncomplete`; else `"ready"`; and `"empty"` for empty text. For mixed audio the outcome is `"ready"` or `"empty"` and the input gets `captureNotice: UNATTRIBUTED_TRANSCRIPT_NOTICE`.
2. Otherwise the transcript is `fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key)?.text` (missing fails `source_missing`).
3. Notes input: `recoveryNotesInput(history, content, transcript, signal, history.capture?.kind === "interrupted")` with `meetingName: history.meetingName` when a checkpoint reads and its context is complete (`settingsSource: "snapshot"`), else `buildCurrentNotesInput` (`"current"`). Then `clearRetriedStages`.
4. `ensureMeetingNotes` if notes are retried; `ensureMeetingSummaries(input, notesText)` if summary is retried. Mentions are already enforced: `getNotes` runs `stripUnknownMentions` against the roster it showed (`notesService.ts:24-30`, pinned by "getNotes strips mention ids the model invented").
5. Success only when every retried stage succeeded: no transcription error, `processing.notes === "generated"`, `processing.summary === "generated"`. Anything else is `stage_failed`. `changes.meetingName` is set only when the input gained a name the row lacked.

The transcription stage counts as succeeded when every retried range or chunk succeeded, even if the stored outcome stays `partial` for capture reasons. Eligibility then reports `capture_incomplete` after that success, and after a `nothing_to_retry` failure. Add the runner test "a checkpoint with no omitted ranges fails nothing_to_retry without generating notes" (asserts `{ kind: "failed", reason: "nothing_to_retry" }` and that `ensureMeetingNotes` was not called).

- [ ] **Step 1: Write the failing tests** (mock the Task 2 module, `meetingRecoveryContent` read and input functions, `meetingNotesService`, `storageService.fetchJsonFromS3`, `processingRetryNotesInput`):

- "notes failure re-runs notes and summary from the stored transcript with frozen settings": result `{ kind: "succeeded", settingsSource: "snapshot", transcriptSource: "existing", changes: { notes: "Regenerated", processing: { transcription: "ready", notes: "generated", summary: "generated" } } }`; `ensureMeetingNotes` saw `finalTranscript: "Stored transcript"`.
- "clears copied notes and summary so the ensure functions regenerate them" (unit): an input `{ processing: { transcription: "partial", notes: "generated", summary: "generated" }, notesText: "old", summarySentence: "s", summaryLabel: "l" }` after `clearRetriedStages(input, partialRow, ["transcription", "notes", "summary"], "ready")` equals `{ processing: { transcription: "ready" } }`.
- "an incomplete snapshot falls back to current settings and says so": `recoveryNotesInput` throws `InvalidRecoveryContent`; `buildCurrentNotesInput` used; `settingsSource: "current"`.
- "a checkpoint transcription retry stores `transcript-retry-<jobId>.json` and keeps attribution": `storeRetryTranscript` called with `"p/g/c_m_t/transcript-retry-job-1.json"` and segments carrying `userId: "123"`; result `transcriptSource: "checkpoint"`, `changes.transcriptS3Key` equal to that key.
- "an unreadable checkpoint falls back to mixed audio": `readRecoveryContent` throws `InvalidRecoveryContent`, `audioS3Key` set; `transcribeMixedRecording` called; `transcriptSource: "mixed"`.
- "a mixed-audio retry adds the unattributed notice": `ensureMeetingNotes` input has `captureNotice: UNATTRIBUTED_TRANSCRIPT_NOTICE`.
- "a re-claimed job reuses its stored retry transcript instead of transcribing again": `fetchJsonFromS3` returns a payload for the retry key; neither transcriber is called.
- `test.each` "fails with %s and returns no changes": notes outcome `failed` -> `stage_failed`; `retranscribeOmittedRanges` rejects -> `stage_failed`; `transcribeMixedRecording` returns `"source_missing"` -> `source_missing`; checkpoint unreadable without `audioS3Key` -> `invalid_snapshot`.
- "a summary that names an unnamed meeting returns the rename": `ensureMeetingSummaries` sets `input.meetingName = "Planning"`; `changes.meetingName === "Planning"`.

In `processingRetryNotesInput.test.ts` (mock discord caches, `getLangfuseChatPrompt`, context lookups): "builds the notes input from current server settings and only earlier meetings"; "throws when the notes prompt cannot be fetched".

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/services/processingRetryStages.test.ts test/services/processingRetryNotesInput.test.ts --coverage=false`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**, splitting the runner into per-stage helpers to stay under complexity 15.
- [ ] **Step 4: Run** the step 2 command plus `test/services/notesService.test.ts test/services/meetingRecoveryService.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: run processing retry stages with existing generation code`

---

### Task 6: Worker

**Files:**

- Create: `src/services/processingRetryWorkerService.ts`
- Modify: `src/webserver.ts:540-541` (start next to the personal upload worker), `src/services/runtimeShutdownService.ts:89-92` (stop with the other polls)
- Test: `test/services/processingRetryWorker.test.ts`

**Interfaces:**

- Consumes: Tasks 3-5.
- Produces `createProcessingRetryWorker(deps: { repository: ProcessingRetryRepository; begin: typeof beginRuntimeWorkClaim; run: typeof runProcessingRetryStages; save: typeof updateMeeting; available(): Promise<boolean>; reader(): RecoveryReader; now(): number; instanceId(): string }): { poll(): Promise<void>; start(): void; stop(): Promise<void> }`, plus `startProcessingRetryWorker()` and `stopProcessingRetryWorker(): Promise<void>` bound to production deps (`createRecordingCheckpointService()` for the reader).
- `PROCESSING_RETRY_WORKER_FAILED_LOG = "Processing retry worker failed"` is logged on poll errors and on `unknown` job failures; Task 8's alarm matches it.

Behavior:

- `poll` returns without a query until `available()` is true, logging `"Processing retry worker idle: flag off or ProcessingRetryDueIndex not ACTIVE"` once per idle period. It asks `listDue` for `PROCESSING_RETRY_MAX_CONCURRENT - running` keys and skips when that is 0.
- Per key: `begin("recovery", "processing-retry:<guildId>:<channelId_timestamp>")`. A throw means it is already running here, so skip. Then require `authority().kind === "serving"`, `getStrong`, `recordClaim`, `repository.claim` (lease `now + 300`), `claimed()`, and renew every 120 s through `trackEffect`, fencing on a failed renewal as `personalMediaUploadWorkerService.ts:92-113` does.
- Before running, `notesVersion !== job.expectedNotesVersion` fails the job `notes_changed`.
- After running: stop and await the renewal so the stored claim matches the job read, then write the terminal state. Success calls `save` with `mutation: { kind: "regeneration", changes }` (`notes`, `summarySentence`, `summaryLabel`, `rename` for each defined value), `actor: { editedBy: job.requestedBy }`, `notesEdit` only with notes (`expectedNotesVersion: job.expectedNotesVersion`, `source: { type: "processing_retry", jobId }`), and `regeneration: { expected, processing, transcriptS3Key, job: terminal }`. On `conflict`, re-read: a moved notes version fails `notes_changed`, a lost claim stops with no write, and anything else retries the save up to `PROCESSING_RETRY_SAVE_ATTEMPTS`. A run failure calls `repository.fail`. Terminal jobs carry `countedAttempts + 1`, no `claim`, and the run's `settingsSource` and `transcriptSource`.
- After a durable terminal write: `acknowledgeTerminal()`, the counter with `outcome` and `reason`, and `captureEvent("meeting_processing_retry_completed", { userId: job.requestedBy, guildId, properties: { outcome, failure_reason, stages, transcript_source, settings_source, duration_ms, counted_attempts } })`. Any thrown error fences, then attempts `fail` with `unknown`.

- [ ] **Step 1: Write the failing tests** with the mock repository from Task 4 and a stub work claim (`signal`, `trackPromise`, `trackEffect`, `authority` -> serving, `recordClaim`, `claimed`, `acknowledgeTerminal`, `fence`, `settle`):

Tests (each asserts on the mock store after `await worker.poll()`):

- "idles without querying while the feature is unavailable": `available` false over two polls; `listDue` never called; the idle warning logged once.
- "claims a queued job and saves its result with processing_retry provenance": `save` called with `mutation.kind === "regeneration"`, a `{ kind: "notes", notes: "Regenerated" }` change, `actor: { editedBy: "111111111111111111" }`, `notesEdit: { expectedNotesVersion: 1, source: { type: "processing_retry", jobId: "job-1" } }`; `acknowledgeTerminal` called.
- "never runs more than two jobs at once": three due keys and a `run` that never resolves give `run` called exactly twice.
- "a failed stage writes only the failed job and removes it from the queue": `run` resolves `{ kind: "failed", reason: "stage_failed", ... }`; `save` not called; `notes`, `processing` and `contentRevision` unchanged; `processingRetry` is `{ status: "failed", failureReason: "stage_failed", countedAttempts: 1 }`; no `processingRetryQueue`.
- "notes edited during the run fail the job with notes_changed and write no content": `run` bumps `notesVersion` to 2 before resolving success; stored job `{ status: "failed", failureReason: "notes_changed" }`, notes unchanged.
- "a lost claim stops without any terminal write": another owner re-claims during `run`; the stored job stays `{ status: "running", claim: { ownerInstanceId: "instance-b" } }`.
- "re-claims a running job whose lease lapsed": stored claim `{ ownerInstanceId: "instance-b", leaseExpiresAt: now - 1 }`; `run` called once; job ends `succeeded`.
- "captures the completed event and counts the outcome": `captureEvent("meeting_processing_retry_completed", ...)` with `properties` containing `outcome: "succeeded"`, `stages: ["notes", "summary"]`, `counted_attempts: 1`, and the counter incremented with `{ outcome: "succeeded", reason: "none" }`.
- "an unexpected error fails the job as unknown and logs the alarm line": `run` rejects; job `{ status: "failed", failureReason: "unknown" }`; `console.error` called with `"Processing retry worker failed"`.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/services/processingRetryWorker.test.ts --coverage=false`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** and wire start and stop. If `test/services/meetingRecoveryShutdown.test.ts` mocks every stopped worker, add the matching mock.
- [ ] **Step 4: Run** the step 2 command plus `test/services/meetingRecoveryShutdown.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: run processing retry jobs in the API runtime`

---

### Task 7: Portal mutation, payload and UI

**Files:**

- Create: `src/trpc/routers/meetingEditPermissions.ts` (move `resolveAttendeeAccessEnabled`, `formatMeetingAccessErrorMessage`, `ensurePortalUserCanAccessMeeting`, `ensurePortalUserCanManageMeetingChannel`, `ensurePortalUserCanEditMeetingNotes` from `meetings.ts:257-400, 438-478` unchanged; `meetings.ts` imports them back), `src/trpc/routers/meetingProcessingRetry.ts`
- Modify: `src/trpc/routers/meetings.ts:914-960` (detail gains `processingRetry`), `:1659-1672` (register `retryProcessing`)
- Create: `src/frontend/pages/library/components/MeetingProcessingRetry.tsx`, `.stories.tsx`, `.test.tsx`; `src/frontend/pages/library/hooks/useProcessingRetry.ts`
- Modify: `src/frontend/utils/meetingLibrary.ts:17-75, 297-343`, `src/frontend/pages/library/hooks/useMeetingDetail.ts:193-199, 291-302`, `src/frontend/pages/library/components/MeetingSummaryPanel.tsx:46-66, 155-170`, `MeetingSummaryPanel.stories.tsx`, `MeetingDetailDrawer.tsx:231-242, 1007-1012`
- Test: `test/trpc/meetingProcessingRetryRouter.test.ts`

**Interfaces:**

- Produces `retryProcessing = authedProcedure.input(z.object({ serverId: z.string(), meetingId: z.string(), replaceNotes: z.boolean().optional() })).mutation(...)`: `NOT_FOUND` for no row; `ensurePortalUserCanEditMeetingNotes` with forbidden message `"Only the meeting starter can retry processing for this meeting."`; then `requestProcessingRetry({ key: { guildId: serverId, channelId_timestamp: meetingId }, requestedBy: ctx.user.id, replaceNotes: replaceNotes ?? false, source: "portal" })`. Map `unavailable` to `PRECONDITION_FAILED` "Processing retry is not available yet.", `replace_confirmation_required` to `BAD_REQUEST` "Confirm replacing the existing notes to retry.", `ineligible` to `PRECONDITION_FAILED` "This meeting cannot be retried right now.", `conflict` to `CONFLICT` "The meeting changed. Refresh and try again.", and `queued` to `{ processingRetry: projectProcessingRetry(history) }`.
- Produces `resolveProcessingRetryView(input: { history: MeetingHistory; serverId: string; channelId: string; user: { id: string; accessToken?: string }; session?: GuildSessionCache }): Promise<ProcessingRetryView>`: flag off gives `projectProcessingRetry(history, "unavailable")`. It runs the edit-permission check only when eligible; any `TRPCError` gives `"not_permitted"`, so the page never fails on a Discord rate limit. The detail payload adds `processingRetry: await resolveProcessingRetryView(...)`. `meetings.ts` must end shorter than 1672 lines.
- Frontend: `MeetingDetailInput` and `MeetingDetails` gain `processingRetry?: ProcessingRetryView`, passed through `buildMeetingDetails`. Add `processingPanelProps(meeting: MeetingDetails): Pick<MeetingCapturePresentation, "processing" | "capture" | "captureCoverage" | "captureNotice" | "recovery" | "recoveryNotice">` in `meetingLibrary.ts`.
- `useProcessingRetry(serverId: string | null, detail: MeetingDetailInput | null): MeetingProcessingRetryProps | undefined` wraps `trpc.meetings.retryProcessing.useMutation`, invalidates `meetings.detail` on settle, and shows the error message through `notifications.show`. `useMeetingDetail` calls it, returns `processingRetry`, and gives the detail query `refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.meeting?.processingRetry?.status ?? "") ? UPDATE_DELIVERY_REFRESH_MS : false`.
- `MeetingProcessingRetryProps = { view: ProcessingRetryView; pending: boolean; onRetry(replaceNotes: boolean): void }`. `MeetingSummaryPanel` gains `processingRetry?: MeetingProcessingRetryProps` and renders `<MeetingProcessingRetry {...processingRetry} processing={processing} />` directly after the `ProcessingNotice` block. The panel stays tRPC-free for Storybook.
- `MeetingDetailDrawer.tsx` must stay at 1334 lines: add `processingRetry,` to the `useMeetingDetail` destructuring and `processingRetry={processingRetry}` to the panel, and replace the six props `processing` through `recoveryNotice` (lines 1007-1012) with `{...processingPanelProps(meeting)}`.
- `MeetingProcessingRetry` copy (Mantine `Button`, `Modal`, `Checkbox`, `Text`, `Loader`):
  - Action: "Retry processing". Modal title "Retry processing?" and body "Chronote will re-run the steps that failed and update this meeting and its Discord posts."
  - With `requiresReplaceConfirm`: "This replaces the current notes with newly generated notes." plus a checkbox "Replace the current notes", which must be checked before the confirm button "Retry" enables; confirm calls `onRetry(true)`.
  - `queued`/`running`: a `role="status"` line "Retrying processing. This can take a few minutes."
  - `failed`, by `failureReason`: `stage_failed` "The retry could not finish. Nothing was changed."; `notes_changed` "The notes changed while the retry ran, so nothing was saved."; `source_missing` "The recording needed for a retry is no longer available."; `invalid_snapshot` "The saved recording could not be read, so nothing was saved."; `unknown` "The retry stopped unexpectedly. Nothing was changed."; followed by "{n} attempts left."
  - `succeeded` with `settingsSource: "current"`: "This retry used the server's current settings."
  - Ineligible reasons shown: `attempts_exhausted` "No retries are left for this meeting."; `notes_edited` "Retry is unavailable because these notes were edited."; `source_missing` (same as above); `capture_incomplete` "Some audio was never recorded, so a retry cannot recover it." All other reasons render nothing.
  - Portal-only summary notice when `processing.summary === "failed"` and `getMeetingProcessingNotice` returns nothing: "The summary could not be generated for this recording." `getMeetingProcessingNotice` is untouched because Discord footers use it.

- [ ] **Step 1: Write the failing router tests** with `buildCaller` from `test/utils/trpcCaller.ts`, mocking `meetingHistoryService.getMeetingHistoryService`, `meetingAccessService.checkUserMeetingAccess`, `discordPermissionsService.ensureUserCanManageChannel`, `processingRetryRequestService` and `processingRetryAvailability`: "the meeting owner queues a retry with replaceNotes passed through"; "a viewer who cannot edit notes is forbidden and nothing is requested"; "auto-recorded meetings accept ManageChannels"; `test.each` over the four non-queued results mapping to their codes. For `resolveProcessingRetryView`: "is unavailable when the flag is off"; "reports not_permitted, not an error, when the permission check throws"; "is eligible for an editor".
- [ ] **Step 2: Write the failing component tests** in `MeetingProcessingRetry.test.tsx` (RTL, `act`): "confirming a plain retry calls onRetry(false)"; "replacing notes stays disabled until the replace checkbox is checked, then calls onRetry(true)"; "shows progress while queued"; "shows the failure reason and attempts left"; "says when current settings were used"; "renders nothing for nothing_failed"; "shows the portal summary notice for a summary-only failure".
- [ ] **Step 3: Run to verify they fail**

Run: `yarn test test/trpc/meetingProcessingRetryRouter.test.ts src/frontend/pages/library/components/MeetingProcessingRetry.test.tsx --coverage=false`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**, including stories `Eligible`, `ReplaceNotes`, `Running`, `Failed`, `UsedCurrentSettings`, `AttemptsExhausted` in `MeetingProcessingRetry.stories.tsx`, and `ProcessingRetryAvailable` (`NotesGenerationFailed` args plus `processingRetry`) in `MeetingSummaryPanel.stories.tsx`.
- [ ] **Step 5: Run** the step 3 command plus `test/trpc/meetingsRouter.test.ts src/frontend/pages/library`. Expected: PASS. `wc -l src/frontend/pages/library/components/MeetingDetailDrawer.tsx` prints 1334; `src/trpc/routers/meetings.ts` prints under 1672.
- [ ] **Step 6: Visual review.** Run `yarn storybook`, then `yarn test-storybook`, and do the VLM review of the new screenshots in `test/storybook/screenshots` (action placement next to the notice, modal at drawer width, no clipped copy). No Playwright test is added: mock mode has no worker to move a job, and the component and router tests cover the states.
- [ ] **Step 7: Commit** `feat: retry failed meeting processing from the portal`

---

### Task 8: Infrastructure: index, local table, alarm

**Files:**

- Modify: `_infra/main.tf:2918-2955` (`meeting_history_table`), `scripts/init-dynamodb.js:224-254, 491-492, 543-571`
- Create: `_infra/alerts-processing-retry.tf`
- Test: `test/scripts/processingRetryIndex.test.ts`

**Interfaces:**

- Terraform adds attributes `processingRetryQueue` (S) and `processingRetryDueAt` (N), and `global_secondary_index { name = "ProcessingRetryDueIndex", hash_key = "processingRetryQueue", range_key = "processingRetryDueAt", projection_type = "KEYS_ONLY" }`.
- `init-dynamodb.js` adds the same attributes and index to `MeetingHistoryTable`; `ensureMeetingUpdateDeliveryIndexExists` becomes `ensureMeetingHistoryIndexExists(indexName, attributeNames)`, called once per index, so the two do not duplicate.
- Alarm, required by BASIC's standing rule that unattended production work ships with an emailing alarm: copy `_infra/alerts-openai.tf`'s shape. Filter pattern `"\"Processing retry worker failed\""`, metric `ProcessingRetryWorkerFailed` in namespace `${local.name_prefix}/Logs`, `period = 300`, `threshold = 1`, `alarm_actions` and `ok_actions` on `aws_sns_topic.critical_alerts[0].arn`, and `count = local.alerts_enabled ? 1 : 0`. Job failures are not alarmed, because during an outage they are expected and #474 already alarms.

- [ ] **Step 1: Write the failing test**, modeled on `test/scripts/meetingUpdateDeliveryIndex.test.ts:85-100`: it reads `_infra/main.tf`, `scripts/init-dynamodb.js` and the new alarm file as text and asserts the index name equals `PROCESSING_RETRY_DUE_INDEX`, the hash and range keys, `KEYS_ONLY`, the filter text equals `PROCESSING_RETRY_WORKER_FAILED_LOG`, and `alarm_actions` references `critical_alerts`.
- [ ] **Step 2: Run to verify it fails:** `yarn test test/scripts/processingRetryIndex.test.ts --coverage=false`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** the test passes, `terraform -chdir=_infra fmt -check` exits 0, and `npm run checkov` shows no new finding.
- [ ] **Step 5: Commit** `feat: add ProcessingRetryDueIndex and worker alarm`
- [ ] **Step 6: Rollout note for the PR.** Deploy with the flag off, dispatch `.github/workflows/terraform-plan.yml` for `sandbox` and `production`, and let BASIC apply. Enable `meetings.processingRetry.enabled` only once `getProcessingRetryIndexStatus()` reports `ACTIVE`. Do not apply.

---

### Task 9: Operator script

**Files:**

- Create: `scripts/retry-meeting-processing.ts`
- Test: `test/scripts/retryMeetingProcessing.test.ts`

**Interfaces:**

- Produces `parseRetryProcessingArgs(args: string[]): { from: string; to: string; guildId?: string; operatorUserId: string; apply: boolean }`, built on `node:util` `parseArgs` with `strict: true` (shape of `scripts/billing-history.ts:14-40`). `--from` and `--to` are ISO timestamps with `from < to`; `--operator-user-id` must match `/^\d{17,20}$/`; `--apply` defaults to false.
- Produces `summarizeRetryCandidates(rows: MeetingHistory[]): { byStages: Record<string, number>; skipped: Record<string, number>; queueable: MeetingUpdateKey[]; needsConfirmation: MeetingUpdateKey[] }`, using `getProcessingRetryEligibility(row, "operator")`. Rows with `requiresReplaceConfirm` are skipped under `replace_confirmation_required` and listed, never queued.
- `main` (behind `require.main === module`) pages through `getProcessingRetryRepository().scan`, prints counts, prints only meeting keys (`guildId`, `channelId_timestamp`), and with `--apply` refuses to start unless `isProcessingRetryAvailable()`. It then calls `requestProcessingRetry({ key, requestedBy: operatorUserId, replaceNotes: false, source: "operator" })` per queueable key and prints key and result kind. A header comment says it needs a full app environment (`configService` validates at import) and production AWS credentials, and that a production run follows the existing production approval rules.

- [ ] **Step 1: Write the failing tests**: "defaults to a dry run and requires window and operator"; "rejects an inverted window and a malformed operator id"; "counts by stage set and skip reason, and never queues a notes replacement"; "includes meetings over the user attempt cap".
- [ ] **Step 2: Run to verify they fail:** `yarn test test/scripts/retryMeetingProcessing.test.ts --coverage=false`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** (PASS).
- [ ] **Step 5: Commit** `feat: add operator script to queue processing retries for an incident`

---

### Task 10: Docs, ADR and agent orientation

**Files:**

- Modify: `apps/docs-site/docs/troubleshooting/common-issues.md:59-66`, `apps/docs-site/docs/whats-new/index.md` (top of `## 2026`), `AGENTS.md` (Key flows), `docs/adr-20261028-meeting-processing-retry.md` (Status)

- [ ] **Step 1: Troubleshooting.** After "A processing-failure message is different from an empty recording..." add:

> #### Retry processing
>
> When transcription, notes or the summary failed for a server meeting, the meeting's owner (or someone who can manage the channel, for auto-recorded meetings) can choose **Retry processing** on the meeting page. Chronote re-runs only the steps that failed, then updates the meeting and its existing Discord posts. If the notes were already generated, you confirm replacing them first. Notes someone edited are never replaced. Each meeting allows three attempts. Personal uploads retry on their own and do not show this option.

- [ ] **Step 2: What's New** entry, dated the day the PR opens:

> ### Retry meetings that failed to process
>
> - When a provider outage or error stops transcription, notes or the summary, the meeting's owner can retry from the meeting page. Only the failed steps run again, and existing Discord posts are updated in place. See [Common issues](/troubleshooting/common-issues).

(Check the slug against the page's front matter.)

- [ ] **Step 3: AGENTS.md** Key flows bullet: "- Processing retry: `services/processingRetryEligibility.ts` decides eligibility for the portal, `meetings.retryProcessing` and `scripts/retry-meeting-processing.ts`; jobs live on the MeetingHistory row (`processingRetry`, `ProcessingRetryDueIndex`), run in the API-runtime worker under the `recovery` work domain, and save through `updateMeeting`'s `regeneration` mutation. Gated by `meetings.processingRetry.enabled`, which stays off until the index is ACTIVE. See `docs/adr-20261028-meeting-processing-retry.md`."
- [ ] **Step 4: ADR** status to `Accepted`. Add to Notes: the checkpoint does not record why a span was omitted, so a retry re-transcribes all omitted spans and accepts gate skips; and the row cannot tell an ASR `partial` from a capture `partial`, so the first retry finds out: a checkpoint with nothing to redo fails `nothing_to_retry`, and that or a prior successful retry ends eligibility for the `partial`.
- [ ] **Step 5: Verify:** `yarn docs:check` and `yarn markdownlint:check` exit 0, and `grep -n "—"` on the four files prints nothing new.
- [ ] **Step 6: Commit** `docs: document processing retry`

---

### Task 11: Full gate

- [ ] **Step 1:** `yarn lint:check`. Expected: exit 0.
- [ ] **Step 2:** `yarn prettier:check`. Expected: exit 0.
- [ ] **Step 3:** `yarn test`. Expected: all suites pass and the `jest.config.ts` thresholds hold.
- [ ] **Step 4:** `yarn build:all`. Expected: exit 0.
- [ ] **Step 5:** `yarn docs:check`. Expected: exit 0.
- [ ] **Step 6:** `yarn check:quality --base origin/master` (needs `QUALITY_RATCHET_HOME`, see `docs/engineering/code-quality.md`). Expected: exit 0. A file-size finding on a file listed in Global Constraints means a move or offset was skipped. Fix it; do not request an exception.
- [ ] **Step 7:** `git diff --name-only origin/master...HEAD -- prompts` prints nothing.
- [ ] **Step 8:** Confirm the Storybook screenshots from Task 7 were reviewed after the last UI commit.
