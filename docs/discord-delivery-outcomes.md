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
considering recovery. Do not blindly retry or broaden permissions. This repair
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
