# Meeting processing retry design

Date: 2026-10-28. Status: decisions approved in conversation (BASIC took every recommended default and added the PostHog events). All open questions are answered. The whole document needs BASIC's review before implementation.

Author's calls, not decided by BASIC (please check these while reading):

- The job is stored on the MeetingHistory row, with a new GSI.
- The worker reuses the `recovery` runtime work domain.
- The config flag starts off.
- A job saves content only when every stage it re-ran succeeds, and every attempt counts.
- Rules for what counts as human-edited notes.
- A retry never posts fresh Discord messages.
- `partial` caused only by incomplete capture is not eligible.

## Why

On 2026-10-28 an OpenAI credit outage left two production meetings without notes, and one of them also without a transcript. They were recovered by hand with an operator script (`scripts/recover-outage-meeting-notes.ts` and `scripts/outageMeetingRecoveryPlan.ts` on branch `claude/outage-meeting-recovery`, never merged). The script made a dry run, hashed the planned write, then applied it: a conditional DynamoDB write, an S3 transcript upload, and Discord edits made only after checking that the bot authored each message. The private incident record is in chronote-ops.

That run worked, but every future provider outage, quota rejection or transient failure would need an engineer and production credentials again. Meanwhile the people who own the meeting are looking at a portal notice that says processing failed, with nothing they can do about it. The audio is usually still sitting in S3.

Related work already shipped: an alarm for OpenAI quota and rate-limit rejections (#474), and personal uploads using automatic language detection with chunked transcription (#476).

## Intent

When processing fails for a saved server meeting and the source audio or transcript still exists, the meeting's owner can fix it from the portal with one click. Chronote re-runs only the stages that failed, saves the result the same way any other notes edit is saved, and updates the existing Discord posts in place. After an incident, an operator can queue the same retry for every affected meeting in a time window without hand-writing database updates.

## Goals

1. **Retry from the portal.** The meeting view shows a "Retry processing" action whenever the meeting is eligible (below) and the viewer may edit its notes. Clicking it asks for confirmation and queues a job. The view then shows the job's state until it finishes.
2. **Re-run only what failed.**

   | Stored outcome                                   | Stages re-run                                                                       |
   | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
   | `transcription: failed`, or no usable transcript | transcription, notes, summary                                                       |
   | `transcription: partial`                         | transcription, notes, summary (needs the replace-notes confirmation if notes exist) |
   | `notes: failed` with a usable transcript         | notes, summary                                                                      |
   | `summary: failed` only                           | summary                                                                             |

3. **Best available audio.** Decided by BASIC: when the meeting has a checkpoint, re-transcribe only the snippet ranges that failed, reading each speaker's own checkpoint audio. Successful snippets are kept as they are, and the merged transcript stays attributed to speakers.
   - This is new code. `recoverTranscript` only finishes audio that was never transcribed: it returns an acknowledged `finalText` unchanged, and it treats `omitted` snippets as already handled (`src/services/meetingRecoveryContent.ts:436-485`).
   - Without a checkpoint, the retry re-transcribes the whole mixed `audioS3Key` instead. That path splits the audio into chunks, uses automatic language detection, and produces an unattributed transcript carrying `UNATTRIBUTED_TRANSCRIPT_NOTICE`.
   - If neither audio source exists, the meeting is not eligible for a transcription retry.
4. **Same settings as the original run when possible.** Use the frozen model, prompt and parameter snapshots from the checkpoint's context artifact when present and complete. Otherwise use the server's current settings, record `settingsSource: "current"` on the job, and tell the user in the portal that the retry used current settings.
5. **Saved like any other edit.** The result is written through `updateMeeting` (`src/services/meetingUpdateService.ts`) with a new `regeneration` mutation. That write is a single conditional update covering notes, summary, `processing`, `transcriptS3Key`, the notes version and history, and a delivery request. The existing delivery worker then edits the Discord notes and summary posts, creating or deleting notes messages as the length changes. Notion auto-sync runs once after the commit, as it does for every notes edit.
6. **Never overwrite human edits.**
   - The job captures the notes version it saw at request time, and the final write requires that version to be unchanged.
   - If anyone edited the notes in between, the job fails with `notes_changed` and writes nothing.
   - Existing notes count as never edited by a person only when `notesVersion` is 1 or absent, or when every history entry after version 1 has source `processing_retry`. (Entries with no `source`, from before the field existed, count as human edits after version 1. The generated version 1 entry has no source.) Replacing notes that were edited by a person is refused outright. Replacing notes that were never edited requires an explicit `replaceNotes: true` from the user.
7. **Bulk retry for incidents.** An operator script finds eligible meetings in a time window (optionally one server), prints a dry run, and with `--apply` queues them through the same request function. It never replaces existing notes; meetings that would need that confirmation are listed and skipped.
8. **Measurable.** PostHog events record requests and outcomes (see Analytics).

## Non-goals (v1)

- **Automatic retry when the OpenAI rejection alarm clears.** People and the operator script trigger retries.
- **Personal meetings (uploads).** Upload jobs already retry themselves and have no checkpoint audio. The eligibility check refuses `ownershipScope: personal`.
- **A Discord button.** Buttons are fixed when a post is sent, so a retry button would outlive a successful retry. The notes post already carries an "Open meeting" link.
- **An admin page for meetings.** No meeting-operations admin surface exists today, and incidents are rare enough for a script.
- **Retrying legacy rows without `processing` metadata.** The 2026-09-16 processing outcomes ADR forbids inferring outcomes for legacy rows, so those rows are not eligible.
- **Empty recordings** (`transcription: empty`, `notes: skipped`). Nothing failed, so there is nothing to retry.

## Anti-goals

- A retry that silently replaces notes someone wrote or corrected.
- A retry that posts a new set of Discord messages next to the old ones instead of editing them.
- A retry that leaves the meeting worse than before. A job saves content only when every stage it re-ran succeeded. Otherwise it fails with `stage_failed` and the stored content stays as it was.
- Any second permission model. Retry uses exactly the rule that already gates notes edits.

## Decided

### Who can retry

The rule is `ensurePortalUserCanEditMeetingNotes` (`src/trpc/routers/meetings.ts`): the meeting owner or creator, or someone with ManageChannels on the channel for auto-recorded meetings. Free servers are included, since our outages cause these failures. The operator script runs under AWS credentials and bypasses the per-user rule and the attempt cap. It still applies eligibility and the replace-notes rule.

### Eligibility

`getProcessingRetryEligibility(history)` is a pure function used by the portal payload, the request mutation and the operator script, so all three agree. A meeting is eligible when all of these hold:

- It is a server meeting (not personal), and its lifecycle is complete: not active, and not owned by interrupted-recording recovery.
- `processing` exists, and at least one outcome is `failed`, or transcription is `partial` because ASR failed. A `partial` that comes only from incomplete capture is not eligible, because no retry can recover audio that was never captured. The row does not record which kind of `partial` it is, so the first retry finds out: if the checkpoint has nothing to redo, the job fails with `nothing_to_retry`. After that, or after any successful retry, that `partial` is no longer eligible.
- The stages to re-run have an input: an audio source for transcription, a usable stored transcript for notes, stored notes for summary.
- No retry job is queued or running.
- Fewer than 3 counted attempts have been made.
- Replacing existing notes is either not needed, or allowed by Goal 6 (which sets `requiresReplaceConfirm`).

When a meeting is not eligible, the function returns a fixed reason enum so the portal can explain why.

### Job storage and execution

The job state lives on the MeetingHistory row, because the row is the unit being retried:

- `processingRetry`: an object holding `jobId`, `status` (`queued | running | succeeded | failed`), `stages`, `requestedBy`, `requestedAt`, `expectedNotesVersion`, `replaceNotes`, `countedAttempts`, `settingsSource`, `transcriptSource` (`checkpoint | mixed | existing`), an optional `failureReason` enum (`stage_failed | source_missing | notes_changed | invalid_snapshot | nothing_to_retry | unknown`), `claim` (owner and expiry), and `updatedAt`.
- `processingRetryQueue` and `processingRetryDueAt` hold the job's place in a new sparse GSI, `ProcessingRetryDueIndex` (hash `processingRetryQueue`, range `processingRetryDueAt`, KEYS_ONLY). It mirrors `UpdateDeliveryDueIndex`.

Why not the existing queues:

- `MeetingControlCommand` commands expire after 15 minutes, run only on bot workers, and exist for live controls.
- `updateDeliveryQueue` is shared state that other paths own. Publication repair deletes it, deployment settlement writes it, and its schema pins one literal value.
- A separate table would need a second write and leave a gap between saving and queuing.

The request is one conditional write on the row: it requires `processingRetry` to be absent or terminal, and the stored outcomes and notes version to match what eligibility saw. That condition is what enforces one job per meeting.

A worker in the API runtime (next to the personal media upload worker, since the job needs no gateway connection) handles the jobs:

1. It polls the index every 5 s.
2. It strongly re-reads each row.
3. It claims the job with a lease, renewing the lease while it runs, the same way personal upload jobs do.
4. It runs the stages, at most 2 jobs concurrently per instance.

The worker is admitted through `beginRuntimeWorkClaim` under the existing `recovery` domain (`recovery_processing` work kind). It does not add a new work kind, because that would change the deployment-control contract that the deployment-repair session currently owns. If the `recovery` domain turns out to require an ActiveMeeting lease, stop and ask BASIC rather than adding a kind.

**Attempts and the cap.** Every attempt counts, and users get at most 3. During an outage, the OpenAI rejection alarm (#474) reaches BASIC, and the operator script re-queues affected meetings without the cap. So a user who burns their attempts during an outage is still recovered.

A lost lease, for example during a deploy handoff, lets another instance re-claim the job. Every side effect is idempotent:

- The new transcript goes to a new S3 key, `<meeting folder>/transcript-retry-<jobId>.json`, written with `IfNoneMatch: "*"`. An existing object with the same hash counts as success, which is the script's rule.
- The final write is conditional on the claim and on `expectedNotesVersion`.

The stages reuse existing code, and that reuse is the main point of the design:

- **Transcript:** checkpoint `readRecoveryContent` and `recoverTranscript`, or mixed-audio `splitAudioFile` and `transcribeAudioFiles` with automatic language detection.
- **Notes:** `recoveryNotesInput` when the checkpoint context is present. Otherwise the notes input is built from current settings, as the script did.
- **Generation:** `ensureMeetingNotes` and `ensureMeetingSummaries`. Both return early when a stage already has an outcome, or when `notesText`, `summarySentence` or `summaryLabel` is already set (`src/services/meetingNotesService.ts:13-14, 60-65`). So for every stage being retried, the worker clears both the in-memory `processing` outcome and those fields, including the ones `recoveryNotesInput` copies from history. As today, a summary run can name a meeting that has no name (`assignMeetingName`), which retitles its Discord posts.
- **Job result:** the job succeeds only when every stage it re-ran succeeded. For transcription, that means every range or chunk it re-sent succeeded; the stored outcome can still be `partial` when the capture itself was incomplete. Notes and summary must both end `generated`. The stage functions swallow provider errors and record `failed`, and the job reads those recorded outcomes rather than relying on exceptions.
- **Mentions:** generated notes go through `stripUnknownMentions` against the roster shown to the model.

### Saving and delivery

- **New mutation and history source.** `updateMeeting` gains the `regeneration` mutation, and `NotesEditSource` gains the `processing_retry` value. The mutation sets notes (when regenerated), `summarySentence` and `summaryLabel` (when regenerated), `processing`, `transcriptS3Key` (when re-transcribed), and the terminal `processingRetry` status. It also removes `processingRetryQueue` and `processingRetryDueAt`.
- **Repository work.** `meetingUpdateDeliveryRepository` only writes a fixed list of fields (`src/repositories/meetingUpdateDeliveryRepository.ts:300-319`). It has to learn the regeneration fields and an extra claim condition, and it has to keep treating a retried identical write as already applied. This is changed shared code and needs its own tests.
- **Delivery and versioning.** Delivery is requested in that same write when `initialMeetingUpdatePolicy` allows it. When the meeting was never posted (`unpublished`) or its publication is `held`, the retry saves for the portal only. It never posts fresh Discord messages. Notes regeneration bumps `notesVersion` and appends a `notesHistory` entry with source `processing_retry`, edited by the requester. A summary-only retry does not change notes or bump the version.
- **Failures.** A failed job writes only `processingRetry` (status, reason, counted attempts) and removes it from the queue. Meeting content is untouched.
- **Old transcript.** The previous transcript object stays in S3, and `transcriptS3Key` moves to the new one.

### Portal

- **Payload.** The meeting detail payload gains `processingRetry: { eligible, reason, requiresReplaceConfirm, status, failureReason, settingsSource, attemptsRemaining }`.
- **Mutation.** The new `meetings.retryProcessing({ serverId, meetingId, replaceNotes? })` mutation runs eligibility and the permission rule, then queues the job.
- **Display.** `MeetingSummaryPanel` shows the action next to `ProcessingNotice`, and a modal confirms the request. When notes would be replaced, the modal says so plainly and requires a separate confirmation. While the job is queued or running, the panel shows progress and the detail query polls. A failed job shows its reason and how many attempts remain. A summary failure on its own, which shows no notice today, gets a short notice so the action has context.

### Operator script

- **Command.** `scripts/retry-meeting-processing.ts` takes `--from`, `--to`, an optional `--guild-id`, `--operator-user-id`, and `--apply`.
- **Discovery.** It finds candidates with a filtered scan of MeetingHistory in the time window, because incidents cross servers.
- **Output.** It prints counts by stage set and skip reason. With `--apply`, it queues jobs through the same request service. It writes no user data to the repo or to stdout beyond meeting keys.
- **Who runs it.** Running it against production is an operator action and follows the existing production approval rules.

### Analytics

Captured through `captureEvent` at the shared service layer, with the guild and the acting user as `distinct_id`. Properties are shape only:

- `meeting_processing_retry_requested`:
  - `stages`, the set of stages being re-run
  - `source` (`portal | operator`)
  - `replace_notes` (boolean)
  - `settings_source`
- `meeting_processing_retry_completed`:
  - `outcome` (`succeeded | failed`)
  - `failure_reason`
  - `stages`
  - `transcript_source`
  - `settings_source`
  - `duration_ms`
  - `counted_attempts`

These events add no identifier and no content. The privacy policy already covers "whether transcription and notes generation completed" for the server and acting account, so no policy change is needed. BASIC confirmed that rule on 2026-10-28, and it is now recorded in AGENTS.md. The work also adds Prometheus counters for queued, succeeded and failed jobs by reason.

### Docs

- **Public docs.** Add a short "Retry processing" section to `apps/docs-site/docs/troubleshooting/common-issues.md`, under the processing-failure entries, plus a What's New entry.
- **ADR and AGENTS.md.** The ADR `docs/adr-20261028-meeting-processing-retry.md` records the data contract. AGENTS.md gets one line under Key flows.

## Constraints

- Production runs an old image (`593a6d6`), and deploys are blocked until a separate deployment-repair session finishes. This feature depends on #401 (checkpoints) and #439 (`updateMeeting`), which will only be live after that repair.
- The new GSI needs a Terraform plan and apply. BASIC owns apply. The code must tolerate the index not existing yet: the worker logs and idles, and the request mutation reports the feature as unavailable. Deploy the code with the feature flag off, then apply, then turn the flag on.
- A config flag `meetings.processingRetry.enabled` (default off until the GSI exists) gates the portal action and the worker.
- DynamoDB data compatibility: every new field is optional, and existing rows are untouched until a retry is requested.
- Everything that already applies to generated notes still applies here: the rules in AGENTS.md for mention sanitizing, `allowedMentions`, and artifact access. Artifact-access settings never block processing.

## Left to the builder

- Exact file layout, names of helpers, and how the regeneration mutation is rendered inside `meetingUpdateRender`, as long as Discord posts are edited, not re-sent.
- The progress copy and modal wording, within the existing Mantine patterns.
- Whether `countedAttempts` resets after a success (suggested: no, the cap is a lifetime cap per meeting).
- Poll interval for the detail query while a job runs.
