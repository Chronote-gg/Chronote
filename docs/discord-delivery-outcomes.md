# Discord delivery outcomes

Meeting generation and Discord delivery are separate results. A successful
`meeting_completed` event does not acknowledge delivery: its `transcribed` and
`notes_generated` fields describe requested processing.

The optional `MeetingHistory.delivery` object records the initial finalization
attempt by phase: `processing`, `summary`, `notes`, and `cancellation`. Each
entry contains `outcome`, `intended`, `sent`, and sanitized `errors` (numeric
Discord API code and HTTP status when available). Counts represent logical
messages, not HTTP attempts; a failed edit followed by a successful send counts
as one acknowledged message. A recovered edit error stays visible in `errors`.

Summary/notice outcomes are `edited_existing`, `sent_fallback`, or `failed`.
`sent_fallback` also covers sending when no existing message ID is available.
Notes outcomes are `complete`, `partial`, `failed`, or `not_applicable` when no
notes messages are intended. Missing phase/legacy metadata means UNKNOWN, not
success. The record describes initial delivery, not subsequent manual edits,
notes corrections, message deletions, or current Discord message existence.

`summaryMessageId` can historically fall back to the start-message ID. Do not
use that pointer as proof of final summary delivery; consult `delivery.summary`.
Successful notes-message IDs remain stored even if another batch fails.

Operational logs emit `Meeting delivery degraded` or `Meeting delivery completed`
with meeting/guild correlation, phase, outcomes and counts. Request bodies,
error messages, URLs, notes and transcripts are not included. Failed or partial
delivery marks the active delivery-containing span and parent meeting-end trace
ERROR, but does not prevent remaining sends, artifact/history persistence, or
cleanup. Trace output and the terminal lifecycle event are not user quality scores.

For Discord 50013, inspect effective channel permissions and overwrites before
considering recovery. Do not blindly retry or broaden permissions. Initial delivery outcome recording
adds neither automatic retries nor live resends. It does not change PostHog
instrumentation, public UI, production permissions, or the daily-report job.

## Verification after an authorized deployment

In a controlled test guild, verify successful edit, fallback send, denied send,
and multi-batch partial delivery. Confirm intended/acknowledged counts, ERROR
spans on degradation, persisted metadata, and continued cleanup. Confirm logs
contain only the allowlisted fields. Use explicit authorization for any live
permission changes. Existing production messages are not replayed by deployment.

This is the delivery-outcome slice of issue #140, not its broader logging,
metrics-platform, or voice-disconnect work. Reverting the source commit restores
prior behavior; additive stored metadata requires no data migration or deletion.

## Later intentional updates

The initial `delivery` record retains the meaning above. Later editor saves, imports, approved corrections, renames and other supported canonical actions atomically persist content and `updateDelivery` intent on the same meeting row. Arbitrary manual database writes do not publish automatically. No Streams were added.

The sparse `UpdateDeliveryDueIndex` is durable discovery, followed by a strong base-row read and conditional ownership. The worker polls immediately and every five seconds without overlap, admits at most 25 rows and ten seconds of admission work per poll, and runs at most two claimed meetings concurrently. Updates preserve unrelated fields and initial publication ownership.

Known failed logical attempts count once across claims and restarts, not once per HTTP call. After eight consecutive known failed attempts the update becomes visibly blocked with reason `retry_exhausted`, retaining desired work and target evidence. Honor definite 429 retry timing; other known failures use jittered backoff starting at five seconds and capped at five minutes. Submitted unknown outcomes use GET-only reconciliation. Lease expiry never authorizes replay. Missing recorded posts are blocked rather than automatically recreated.

A publication hold retains new desired edits and never releases itself during an ordinary save. Notification holds are separate. Discord retry execution makes no LLM, Notion, notification or new-export calls. Existing opted-in Notion behavior remains at the successful notes-action boundary.

The safe detail field `updateDelivery` reports desired revision, nullable current synced revision, sanitized state/reason and last verified captured attempt. A last-success timestamp alone cannot establish current convergence. Completed pending meetings refresh without hiding canonical content, for at most 60 sequential reads per open selection; close, switch and terminal states stop refresh.

### Rollout

Deploy the sparse index through the reviewed infrastructure workflow and require ACTIVE readiness before deploying writers and worker. Missing readiness fails visibly. There is no Scan fallback, historical backfill or blanket replay. Keep initial publication, personal creation and exceptional recovery ownership intact. Supported routine edits need no operator preview; exceptional repair retains its exact-preview approval and common per-meeting publication barrier.

Hosted synthetic Sandbox acceptance needs separate authorized rollout and provider evidence. Code checks do not establish hosted acceptance or authorize production deployment or release of a live hold.
