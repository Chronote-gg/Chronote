# Shared meeting updates and durable Discord delivery

Status: Proposed for review; independent source/design review passed
Date: 2026-10-22
Repository baseline: `bb7b2e89b0b0be256efdd27de744f250334ea67e`

## Intent and approved direction

Supported meeting edits should save canonical data once and automatically update
the meeting's existing Discord presentation. An operator should not have to run a
publication command after an ordinary edit. The user chose an intentional shared
application action and explicitly rejected DynamoDB Streams for this change.

A successful save must durably retain the work needed to update Discord, even
when a request or process ends before delivery. Callers keep their existing
authorization and correction approval flows. Routine propagation does not require
a second operator preview approval.

This first change makes Discord delivery durable. Existing opted-in Notion
automation remains at the shared action boundary with its current guarantees.
It does not enable new exports, recipients or automated Notion retries. Durable
Notion delivery is separate work because its multi-request replacement and
uncertain-mutation protocol need their own design.

## Current behavior and demonstrated gaps

Source was inspected at the baseline above:

- `src/trpc/routers/meetings.ts` saves portal edits, imports and corrections
  through `updateMeetingNotesService`, then performs Discord delivery in the
  request. An edit/import does not regenerate summaries. Correction generation
  happens before the save.
- `src/commands/notesCorrections.ts` separately persists and delivers Discord
  corrections. Its summary warning and automatic-name behavior differs from the
  portal correction path.
- `src/services/meetingHistoryService.ts` saves notes and then attempts existing
  Notion automation. It does not persist pending Discord delivery.
- `src/db.ts:updateMeetingNotes` uses a conditional `UpdateItem` with notes
  version/history/provenance. `updateMeetingName` changes the name without
  incrementing `notesVersion`.
- Portal and Discord rename paths independently patch notes embed titles.
  `meetingNotesEmbedService.ts` replaces the embed array with its first embed,
  which is unsafe for batched or unrelated embeds. Summary titles can remain old.
- The recovery publication planner compares an untouched summary with a freshly
  rendered summary and blocks an otherwise valid notes-only update when the old
  summary lacks a capture warning.
- Initial recording delivery and recovery already have separate ownership,
  submission receipts and interruption protocols. Their records describe initial
  delivery, not synchronization after later edits.

## Scope and ownership

Implement one shared `updateMeeting` application action behind existing
services. It accepts typed mutation variants for notes edits/imports/corrections,
renames, and explicit presentation refresh or recovery delivery requests. Actors
and permissions remain at the existing API, command and operator boundaries.
A background worker receives previously authorized work, not a new public
permission model.

Move the existing best-effort Notion hook to exactly one successful notes-update
path in the shared action and remove the old service hook in the same changeset.
Call it only after canonical content and Discord intent are acknowledged. Retain
its canonical re-read, opt-in checks, interruption ownership and
\`assertNotionOutcomeKnown\` handling. CAS failures, name-only updates and Discord
worker retries do not invoke it. This preserves current behavior without a
second Notion invocation or a claim of durable Notion synchronization.

The action owns canonical content changes, audit/provenance/version updates and
the atomic durable delivery request. It returns a committed save result plus
Discord delivery state. It may wake the worker for low latency, but that wakeup
is never the only record of delivery.

Migrate supported post-publication writers together:

| Entry point                    | Responsibility after migration                                                 |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Portal editor and import       | Validate access and input, call the shared action                              |
| Portal and Discord corrections | Generate and approve once, then call the action with the approved result       |
| Portal and Discord rename      | Resolve authorized name, then call the action                                  |
| Presentation refresh           | Explicitly request changed warning/title/summary fields through the action     |
| Operator recovery delivery     | Respect stored-content and publication holds; join the common delivery barrier |

Delete the migrated caller-owned Discord edit/replacement helpers. Retain a
single renderer/delivery implementation. No retry reruns an LLM, a correction
approval, Notion automation or a notification.

Initial live delivery, recording recovery generation and personal-upload
creation keep their existing owner/claim protocols. The update worker cannot
take over an unfinished or uncertain initial publication. Initial target
registration must merge metadata without overwriting a newer content revision
or delivery intent. Already completed personal meetings use the normal action;
meetings with no Discord destination remain unpublished.

Raw console writes are outside the automatic propagation contract. Supported
repair tooling must use the action or explicitly retain/reestablish pending
delivery. Tighten `scripts/recover-meeting-artifacts.ts`, which currently spreads
an old row into a conditional `PutItem`: it must use field-specific conditional
updates or a full revision check so it cannot erase newer content or intent.

## Durable state on the existing meeting row

Add an optional monotonic `contentRevision` separate from `notesVersion`.
Each canonical mutation affecting published fields increments it. Notes edits
retain their current notes-version and history semantics; rename and warning
changes advance content revision without inventing a notes edit.

Legacy missing `contentRevision` is baseline zero. Existing missing notes
version remains baseline one. Additive fields do not invalidate existing history.

The same conditional database mutation writes canonical changes and a compact
`updateDelivery` request. There is no save-then-enqueue gap and no separate queue
service or queue table.

The request records:

- Desired and acknowledged revisions for the affected presentation parts.
- Publication mode, pending/retrying/synced/held/blocked/uncertain state,
  sanitized reason, attempts and next check time.
- A separate active attempt identity, owner, lease, captured revision and compact
  per-message before/desired fingerprints with prepared/submitted/verified state.

Presentation parts distinguish notes body, notes title, notes warning, summary
body, summary title and summary warning. Their revision watermarks prevent a
rename from clearing an outstanding notes update, and prevent an old completion
from acknowledging newer work. The final typed model must make contradictory
claim/submission states unrepresentable.

An ordinary notes-only edit requests notes changes. It does not request summary
rewrites. A body update includes its version footer, required notice and any
pagination labels needed to render that body coherently. Likewise, an explicitly
requested summary body update uses the shared capture-notice renderer. These
dependencies do not authorize changing an unrelated summary.

A rename requests the managed notes and summary title parts.
Corrections request any notes, summaries or automatic name actually changed by
the existing correction flow. A warning refresh explicitly requests notice
changes. An informational difference in an untouched summary never blocks a
notes-only update.

A new save may advance desired work while a delivery attempt is running. It must
not replace that attempt's identity, submitted markers or uncertainty. Completion
advances only the captured part revisions under the exact attempt condition.
The newer desired work remains pending. A failed compare-and-set is re-read,
never interpreted as successful delivery. If a newer revision supersedes a
settled pagination attempt before pointer registration, retire that attempt
without losing its created IDs. Carry its known owned candidates into latest
replanning, reuse or clean them up only under fresh claim/pointer checks, and do
not leave stale work blocking the newer revision. An unsettled submission
continues to hold newer work.

Store hashes, IDs and bounded metadata in the intent, not duplicated notes,
transcripts or Discord message bodies. Validate the DynamoDB item size before a
write; a rejected update must leave both content and intent unchanged.

## Discovery and worker lifecycle

Add a sparse `UpdateDeliveryDueIndex` to `MeetingHistory`, using top-level
`updateDeliveryQueue` and `updateDeliveryDueAt` attributes and a `KEYS_ONLY`
projection. Runnable pending/retry/reconciliation work has index keys. Completed,
unpublished, explicitly held and terminally blocked work has no due keys.

Use a versioned constant queue partition and numeric due timestamp. Query
`queue = :queue AND dueAt <= :now`, with bounded page sizes and a bounded poll
budget. Do not use a history scan or an unbounded catch-up loop. Start with the
existing application's scale; no speculative queue sharding.

Index discovery is eventually consistent. Strongly read the base row and
revalidate every condition before claiming it. Missing or stale index entries
are not proof of current state. A recorded active attempt becomes discoverable
for read-only recovery at its next check, but lease expiry alone never permits
another Discord write.

Register one REST-only worker in `src/apps/bootstrap.ts` through
`whenRuntimeServing`, for combined, API-only and bot-only runtimes. Multiple
instances may discover the same row; existing deployment admission transactions
and conditional claims select one owner. The worker needs no gateway client.

Use a nonoverlapping immediate poll followed by a five-second interval. Cap each
poll at 25 candidate rows and 10 seconds of admission work; later polls continue
from a saved in-memory cursor, and restart safely from the beginning. Provider
work is tracked separately and bounded by per-request deadlines. Two claimed
meetings may progress concurrently, with sequential mutation per meeting.

Integrate a `meeting_update_delivery` work domain with existing
`ancillary_delivery` accounting and serving admission. Shutdown stops discovery
and renewal admissions, fences new effects and awaits actual tracked promises.
A durable handoff acknowledgment never releases an unsettled local provider
effect. Follow existing runtime lifetime tests rather than adding a parallel
shutdown model.

## Delivery behavior and field preservation

The worker reads the latest canonical row before preparing a never-submitted
attempt. Pending changes coalesce into the latest content. It validates saved
guild/channel/message ownership and plans only requested presentation parts.

Reuse the recovery planner's careful embed normalization, merging, limit checks
and warning preservation, without requiring its legacy recovery manifest for
ordinary authorized edits. Unrelated embeds, ordinary message content,
components, links, attachments, colors and timestamps survive.

PATCH only the intended embeds and `allowed_mentions: { parse: [] }`.
Do not send content/components/attachments fields merely to restate their
before-image. Notes include the current version and required uncertainty notice.
Summary rendering uses the same capture-notice helper when that summary part is
actually requested. An untouched manually edited summary is preserved.

Before every mutation, verify current claim/admission, canonical revision and
saved message pointers. Read each result back. Before marking parts synced,
verify the target fingerprints and the exact revision/attempt in the database.
Skip a target already matching the intended state.

Normal editor/import/correction pagination must continue working. Do not copy
the repair CLI's blanket ban on changing slot counts. Prefer editing existing
owned slots, then durably record any needed page additions/removals. Every
POST/PATCH/DELETE requires a recorded operation intent before submission.
Persist returned new IDs before proceeding, and publish the complete new pointer
set only under the current claim/revision and expected-old-pointers condition.
An uncertain pointer-write acknowledgment requires strong exact readback before
cleanup. Preserve created-but-not-yet-registered IDs in the attempt across
restarts. Remove only recorded obsolete bot-owned notes slots; preserve messages with unrelated content or controls.
Never delete a summary, a replacement somebody else registered, or an unrelated
embed. Preflight the entire supported layout before the first write.

Missing recorded posts or inaccessible destinations become a visible blocked
state. The worker does not treat a missing post as authorization to recreate it
or redirect to another channel. Pagination additions are part of an existing
valid notes layout, not a missing-target fallback.

## Retries, ordering and uncertain outcomes

The guarantee is durable pending work and verified convergence when provider
outcomes are known. DynamoDB and Discord do not support a shared transaction or
a conditional Discord revision write. Do not claim exactly-once delivery or
that a database lease can fence a late HTTP request.

Persist prepared intent, then a submitted marker before each provider mutation.
If that marker's acknowledgment is unknown, do not send the provider request.
Use exact claim readback to establish whether it was recorded. An ambiguous POST
without a returned message ID cannot be reconciled by targeted GET; retain an
uncertainty hold. A deterministic nonce may supplement evidence but does not
permit blind recreation.

Known non-submitted failures and definite rate-limit rejections retry
automatically. Honor Discord retry timing and otherwise use jittered exponential
backoff, starting at five seconds and capped at five minutes. Retain pending
work across restarts. Exhaustion must become visible, not be discarded.

A timeout, disconnect, uncertain provider response, interruption after submission
or unacknowledged completion write enters read-only reconciliation. Fetch the
exact recorded targets and compare fingerprints. A matching observation proves
the content observed, not that an abandoned process or remote request settled.
Unsettled old effects block newer writes to the same meeting. Do not blindly
retry PATCH, recreate a timed-out POST or repeat a destructive step.

Where local lifetime tracking and durable evidence establish the previous
effect is settled, reconciliation may complete the original attempt or schedule
a safe next attempt. Otherwise retain an uncertainty hold for explicit repair.
A lease timeout, process age or successful unrelated GET is insufficient.
New edits retain their pending desired revisions behind that hold.

Completed known attempts leave the latest revision pending if content changed
during delivery. No older database acknowledgment can clear the newer work.
A mutation that races between the final check and provider write can briefly
show older content; the newer durable request must remain discoverable. This
external race is a limitation, not permission to mark stale content synced.

## Publication holds and competing delivery paths

Distinguish `unpublished`, `active` and `held` publication modes. A notification
hold suppresses announcements; an explicit content-publication hold suppresses
embed updates. Keep these meanings separate for new actions.

Existing stored-only recovery authorization must not be reinterpreted as
permission to publish. Preserve legacy recovery holds until an explicit
authorized publication action establishes active delivery. Normal notes edits
do not silently release a hold. Releasing a content hold atomically schedules
the latest requested presentation.

Deploying the feature does not enqueue or replay historical meetings. Legacy
published meetings enroll on their next supported intentional edit only after
their initial delivery/recovery is known settled. Existing message pointers
alone do not prove that a possibly-start-message summary is a settled final
summary. Legacy missing outcome metadata requires explicit target validation
and adoption; an unfamiliar or actively-owned layout stays held.

The repair CLI's current S3 claim is not a worker lock. Before enabling the new
worker, migrate repair apply/reconcile to the common per-meeting database
delivery barrier. Preserve existing approved preview/receipt semantics.
If a legacy repair run is still active or uncertain, adoption remains held.
There must never be an old S3-locked publisher and new database-locked worker
writing the same meeting independently.

## API and user experience

A save acknowledges canonical persistence and reports delivery separately.
Expose desired/synced revision, last successful sync, state and a sanitized
reason through existing meeting detail responses.

The portal can show a compact status beside the save result:

- Saved. Updating Discord.
- Saved. Discord is up to date.
- Saved. Discord update needs attention.
- Saved. Publication is on hold.

Corrections acknowledge approval/save without waiting for all provider work.
Existing correction provenance, teaching context and token consumption remain
unchanged. Keep user-facing provider failures free of raw content, credentials
or private channel details. Retry/release-hold actions reuse existing edit or
operator authorization, and never overwrite an unsettled attempt.

The normal action is the supported repair path for intentionally changed
canonical content. The operator preview remains available for inspection and
exceptional reconciliation; it is not required for routine synchronization.

## Infrastructure and rollout

- Add the sparse GSI and attributes in `_infra/main.tf`. Preserve existing
  encryption, backups, table keys and stored data.
- Extend `scripts/init-dynamodb.js` for new and existing local tables,
  following the idempotent renewal-index upgrade pattern.
- Review existing IAM table/index access and add only any missing narrowly
  scoped permissions. Verify index readiness before activating writers/worker.
- Deploy the index first through the existing reviewed Terraform workflow.
  Require ACTIVE index state. Missing infrastructure fails visibly; no Scan
  fallback or successful save with silently disabled durable work.
- Ship the additive state/repository/worker with migrations of all supported
  edit and rename callers together. Remove their independent Discord writes.
- No Streams, SQS, Lambda, historical backfill or blanket production repair.
  Existing initial-publication and recovery owners retain their current guards.

Sandbox acceptance uses synthetic meetings and proves convergence after process
interruption, retry, rename, correction and pagination changes. Private live
evidence belongs in `chronote-ops`. A merged PR and unit tests do not establish
hosted acceptance. Production infrastructure/deployment and any held live
publication remain separate operational actions.

## Changeset map

| Area                        | Files and intended responsibility                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain and persistence      | `src/types/db.ts`, a focused update-delivery schema, `src/db.ts`, `src/repositories/meetingHistoryRepository.ts`, and a delivery-only repository                                                    |
| Shared action               | `src/services/meetingHistoryService.ts`, a focused meeting-update action; retain existing Notion policy at the action boundary                                                                      |
| Rendering and provider work | Extract general managed-field planning from `recoveryDiscordPublicationPlan.ts`; reuse `discordMessageEditor.ts`; add focused delivery/reconciliation service                                       |
| Worker and runtime          | New delivery worker; `src/apps/bootstrap.ts`, runtime admission/lifetime/shutdown services and domain types                                                                                         |
| Callers                     | Portal editor/import/correction/rename in `src/trpc/routers/meetings.ts`; `src/commands/notesCorrections.ts`, `src/commands/meetingName.ts`; remove migrated `meetingNotesEmbedService.ts` behavior |
| Lifecycle and repair        | Initial target registration, recovery eligibility, `scripts/recover-meeting-artifacts.ts`, recovery publication apply/reconcile barrier                                                             |
| Infrastructure              | `_infra/main.tf`, `scripts/init-dynamodb.js`; review deployment ordering and local/mock configuration                                                                                               |
| Visibility and docs         | Meeting detail delivery status, component stories/tests, public feature docs, delivery/operator docs and short ADR; review AGENTS/copilot/README accuracy                                           |

## Verification requirements

Use failing tests for the current save-without-delivery gap before implementation.

1. Real local DynamoDB integration proves one conditional mutation saves content
   and intent together, including conflicts, legacy revisions and item limits.
2. Portal/Discord editor, import, correction and rename tests prove all supported
   callers use the shared action and have no independent Discord mutation path.
3. Renderer tests preserve warnings, controls, attachments, unrelated embeds and
   multi-embed layouts. Notes-only work tolerates unrelated summary differences.
4. Worker tests cover restart after save, lost wakeup, stale GSI discovery,
   pagination, bounded polling, competing owners, updates during PATCH, stale
   acknowledgments and independent part revisions.
5. Submission tests cover crashes before/after recorded intent, definite
   rejections, delayed/unknown PATCH and POST outcomes, GET-only reconciliation,
   no blind retry and no progress based solely on lease expiry.
6. Pagination tests preserve normal growth/shrink behavior, register new IDs
   safely, and never duplicate an uncertain creation or delete unrelated data.
7. Hold/adoption tests preserve stored-only recovery authorization and prohibit
   competing initial/repair/worker publishers. Existing historical rows are not
   automatically replayed by deploy.
8. Runtime tests prove serving admission, protection loss, graceful shutdown and
   actual effect tails across combined/API-only/bot-only entry points.
9. Existing Notion automation behavior remains covered; Discord retries make
   zero LLM, Notion, notification or new-export calls.
10. Run required quality, lint, formatting, TypeScript, unit/integration, docs and
    relevant UI/visual/E2E checks. Report hosted Sandbox evidence separately.
    No quality-exception label without explicit user authorization.

## Alternatives and supporting references

Direct in-request fan-out is simpler but loses delivery between a successful
save and interrupted provider call. A separate outbox table can be made atomic
with DynamoDB transactions, but a compact same-row intent uses the existing
mutation and avoids a new table. Database Streams were considered and rejected
by the user; arbitrary database writes do not silently publish.

Source anchors:

- [Current portal save and Discord sync](../../../src/trpc/routers/meetings.ts)
- [Current notes service and Notion hook](../../../src/services/meetingHistoryService.ts)
- [Existing due-query worker pattern](../../../src/services/renewalRecoveryWorkerService.ts)
- [Runtime ownership and settlement](../../../src/services/runtimeWorkAdmissionService.ts)
- [Existing initial delivery outcomes](../../discord-delivery-outcomes.md)
- [Existing recovery publication operations](../../operations/recovery-discord-publication.md)

Provider contracts:

- [DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html):
  GSIs provide eventually consistent discovery, not a claim or canonical read.
- [DynamoDB sparse indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-indexes-general-sparse-indexes.html):
  optional due attributes keep terminal/held rows outside the work index.
- [Discord message editing](https://docs.discord.com/developers/resources/message#edit-message):
  preserve omitted message fields and explicitly suppress mentions.
