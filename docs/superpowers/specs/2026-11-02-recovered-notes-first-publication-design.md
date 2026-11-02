# First Discord publication of recovered notes

## Review brief

Publish the approved recovered notes for the two unarchived October meetings as
new Discord notes posts. Skip archived meetings entirely. The October 14 meeting
is currently archived, so its missing Embed Links permission needs no action.
Its recovered text remains stored and its publication hold remains intact.

This is a design for an operator command, not a production execution approval.
Production remains read-only during design and implementation. After testing,
the operator must review and approve an exact publication preview before apply.

Confirmed decisions:

- Archived meetings do not need Discord publication. Do not unarchive them,
  request permissions for them, or change their saved recovery content.
- Preserve the approved notes, original language, uncertainty and partial-capture
  outcomes. Do not regenerate notes or invent recording duration or end times.
- Reuse the guarded publication machinery discussed in the investigation.

Recommendations for approval with this design:

- Publish notes only, without a summary or separate announcement.
- Keep automatic update delivery and Notion held after publication. This makes
  the operation a one-time publication; later automatic updates remain separate.
- Block archive/unarchive while an exclusive publication operation is running or
  unresolved. Return a retryable conflict, rather than silently ignoring either
  operation. This closes a real archive-versus-send race.

The main tradeoff is that a Discord timeout can temporarily block archive changes
until an operator reconciles the send. We accept this instead of risking a
duplicate post or sending after an acknowledged archive operation.
If the message ID and independent provider evidence are both lost, that block can
be indefinite. This bounded extension has no force-clear or automatic resend.

## Current evidence and scope

The read-only investigation on November 2 found:

| Meeting | Current archive state | Saved destination access           | Proposed outcome           |
| ------- | --------------------- | ---------------------------------- | -------------------------- |
| Oct 12  | Unarchived            | Bot can view, read, send and embed | Preview one new notes post |
| Oct 13  | Unarchived            | Bot can view, read, send and embed | Preview one new notes post |
| Oct 14  | Archived              | Not relevant to this operation     | Skip without Discord calls |

All three have notes version 2, approved recovery hashes, publication held, zero
delivery attempts and no saved notes or summary message pointers. Each currently
fits in one notes embed. These facts must be refreshed at preview/apply time.

The original start posts survive and identify the exact meetings. They are not
notes targets. Nearby Oct 12 notes and summaries belong to different completed
meetings, confirmed against their saved message pointers. Never edit those posts.
The history investigation was bounded, so it does not prove that no untracked
duplicate exists anywhere in channel history.

The existing recovery editor requires saved message IDs and an older recovery
manifest shape. The routine update planner also requires an existing first notes
message. Releasing the hold alone returns `missing_target`.

## Approaches

| Approach                                                            | Benefit                                                                 | Cost or limitation                                                                             | Decision                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Add explicit first-publication mode to the guarded operator tool    | Reuses identity, previews, claims and receipts; confines POST authority | Needs new schemas, POST reconciliation and conditional pointer registration                    | Recommended, follows the previously proposed extension |
| Teach the routine worker to publish any missing first notes message | Could serve later recovery cases                                        | Broadens background behavior and cannot rely on this operator's exact approval                 | Deferred                                               |
| Send manually or repurpose the start embed                          | Little initial code                                                     | Loses durable duplicate protection and pointer registration, or overwrites historical controls | Rejected                                               |

Keep existing editor previews, digests and PATCH-only transport unchanged. Use an
explicit first-publication command mode with its own discriminated schemas and
create-only transport capability. Reuse shared primitives without coercing a
version-2 recovery into legacy fields that never existed.

## Operator and recipient experience

The operator selects the same three recovery identities. Preview reports the
archived meeting as `skipped_archived`, with no proposed message or write. It
shows the exact proposed posts and conditional history updates for the other two.
It does not release their holds or create cloud previews, claims or receipts.
Preview artifacts are owner-only local files.

Recipients see a newly posted recovery note, dated to its original meeting rather
than presented as a new recording. Use the existing paginated notes renderer,
with a deterministic title containing the original UTC meeting date and time,
the approved body, recovered version footer, interrupted-capture prefix, unknown
coverage/end notices and partial-transcription warning. Include a link button to
that meeting's existing portal route. The preview binds the exact title, link,
components, embeds and `allowed_mentions: { parse: [] }` payload.

Do not add summaries, recording controls, correction buttons, pings, attachments,
Notion actions or unrelated notices. Preserve original recording-start messages.
For this bounded recovery mode, reject a body that needs more than one Discord
message; current recoveries each fit. Supporting multi-message first publication
is deferred, avoiding an unnecessary second partial-send problem.

The operator flow is:

1. Read the selected recovery rows and classify archive state.
2. Skip archived rows; validate and render the remaining rows.
3. Inspect exact local previews, skip list and conditional changes.
4. Obtain separate approval of the complete preview digest.
5. Apply with fresh preflight, exclusive ownership, durable intent and one POST
   per eligible meeting.
6. Verify Discord and persist its pointers, or stop for reconciliation.

No new portal pages or user navigation are introduced. Existing portal links and
the current operator preview flow are reused; external UX reference research is
not needed for these settled flows.

## Eligibility and source binding

Read each selected row consistently. Missing/invalid archive state is an error;
absence of `archivedAt` means unarchived under the existing data contract. A valid
archived row is skipped before Discord permission checks or publication claims.
The batch preview binds both eligible and skipped identities. Apply never adds
an originally skipped meeting, even if someone subsequently unarchives it.

Eligible rows must match the approved recovery identity, account, region, table,
bucket and version-2 manifest location. Validate manifest/row linkage, notes and
transcript object hashes, recovery ID, version, language/classification and
partial/unknown outcomes. Verify the stored notes against their immutable object.
Use the manifest's real preparation time and nullable previous-artifact fields;
do not synthesize old transcript keys, versions or an original apply timestamp.

Require `interrupted` lifecycle, no active target lease, no unsettled original
publication, no notes or summary pointers, no retained update attempt/candidates,
no unresolved publication owner and the expected `stored_only` hold. An existing
verified first-publication receipt takes the read-only verification path. Other
preexisting publication evidence blocks a new POST and requires reconciliation.

Bind the current notes/content/delivery revisions, text destination, archive state,
capture state/coverage, processing warnings and transcript pointer. Inspect the
approved destination with the current bot identity; require the matching guild,
ordinary text-channel type, View Channel, Read Message History, Send Messages and
Embed Links, and no active member timeout. Do not silently choose another channel.
Permission checks are preflight evidence, not proof of a future successful send.
Retain the stored destination for this bounded mode; alternate-channel selection
is outside its authority.

Refresh a bounded duplicate search anchored to the original start post and the
publication receipt/intent history. Only exact meeting linkage is authoritative;
similar text or proximity is not enough to adopt or edit another post. Any
ambiguous candidate blocks publication. The operator sees the search bounds and
remaining uncertainty in the preview. A new search result affecting the decision
requires a new preview, not silent adoption.

## Archive and concurrent-writer contract

The current common publication snapshot omits archive fields, the destination,
capture coverage and transcript pointer. Include the first-publication binding
fields in its conditional acquisition/ownership checks. Preserve legacy preview
digest compatibility through a separate versioned binding; do not silently
reinterpret saved legacy previews.

The archive writer in `src/db.ts` and its mock repository must condition their
archive/unarchive update on no running publication repair owner. Propagate an
explicit conflict through the service and tRPC mutation, not a misleading
not-found result. Both writes share the same row:

- Archive commits first: publication's archive-bound acquisition fails. No POST.
- Publication claims first: archive returns a conflict until publication settles.
- Ownership or history drift before submission: stop without a POST.
- Submission already recorded: keep ownership until its outcome is reconciled;
  archive cannot race an in-flight or late-completing POST.

After verified publication settles, archiving works normally and does not delete
the already published notes. No cross-system transaction can retract a submitted
Discord request. Out-of-band database edits bypassing these contracts remain
outside the supported concurrency guarantee.

Because archive exclusion changes a serving write path, source tests alone are
insufficient. Before production apply, separately authorize and deploy the archive
guard to every supported archive writer, verify the serving API/runtime version,
and prove the conflicting archive response in Sandbox. The operator apply command
must refuse execution without a recorded, verified runtime prerequisite for that
exact environment. Read-only preview does not require that deployment. No task in
this design authorizes a production deployment by itself.

## Apply, persistence and recovery

Apply accepts only a ready saved preview and its exact digest. Regenerate the
payload from current bound source data, refresh permissions and duplicate
evidence, and preflight all eligible meetings before the first mutation. Any
archive/content/destination drift invalidates the preview before sending.

Use the common exclusive publication owner to fence canonical content updates
and routine delivery. Establish an insert-only durable intent for this meeting,
recovery and notes version. Authority is not partitioned by preview digest:
creating another preview must not permit a second first-publication attempt.
Receipts record run IDs and preview digests beneath that stable authority.

Process eligible meetings sequentially. Before each POST, durably save the exact
payload hash and `submitted` state, then revalidate ownership/source/archive and
destination. The create-only transport exposes GET and POST, no PATCH or DELETE,
no redirects, no automatic retries and a bounded request timeout.

After a successful POST response, persist the returned message ID and GET it.
Verify channel, bot author, no webhook, exact normalized embeds/components and
safe mention payload. Only then conditionally register `notesChannelId` and
`notesMessageIds`, acknowledge the captured notes-body revision, and settle the
owner in one DynamoDB update. Require the same owner, source binding, absent
pointers and unchanged captured revisions. Read the result strongly before
marking the private receipt verified.

This settlement needs a dedicated repository operation: the current repair
repository cannot register pointers. Preserve notes/version, transcript,
historical lifecycle/delivery evidence, archive state and recovery provenance.
Keep `updateDelivery.policy` held for `stored_only`, set the acknowledged current
notes-body work to synced, and leave Notion and separate notification status held.
The new receipt records actual first publication; do not rewrite the stored-only
import manifest or claim that an old recording delivered normally.

Also provide a conditional `settle_without_publication` operation. It settles
only the exact owned run, records a failed/not-submitted receipt and leaves
pointers, source content and all publication holds unchanged. It removes no
recorded submission or uncertainty. The executing apply run may use this path
within its existing authorization only when it durably proves the POST was never
invoked, or has an unambiguous rejecting provider response. If any submission
marker could belong to an in-flight request, it cannot use this path.

After process loss, read-only reconciliation can propose this same settlement
with exact owner/receipt before-images, a confirmed-stopped run and positive
no-send/rejection evidence. Applying that settlement requires separate explicit
approval. Archive remains excluded until settlement commits and is read back.
Known-unsent settlement does not itself authorize a new send: a later attempt
needs a fresh preview/approval and a new generation under the same stable
meeting/recovery/version authority, preserving previous attempt receipts.

Failure rules:

- A definite provider rejection records failure and permits a later explicitly
  approved attempt only after reconciliation proves no unresolved submission.
- A timeout, lost response, uncertain receipt write or unknown database outcome
  stops the batch. Do not automatically retry the POST, release authority, delete
  a message or roll back a successful earlier meeting.
- Reconciliation itself is read-only. With a known message ID, verify Discord,
  receipts and history. If a verified message needs pointer registration, prepare
  a separate conditional finalization diff for explicit approval.
- Without a known ID, inspect bounded history and durable evidence. Matching
  content alone does not establish identity; an absent search result does not
  prove the request cannot complete later. Keep the operation uncertain until
  the exact previous run is confirmed stopped and its effect is resolved.
  This mode intentionally adds no provider correlation marker or force-release
  mechanism. Resolution needs independent positive evidence that identifies the
  actual message ID, such as a retained provider response or request trace,
  followed by exact GET verification. Without that evidence, even a stopped run
  remains uncertain indefinitely; manual forensic recovery is a separate task.
- A verified rerun performs only reads. Report each meeting separately as
  verified, skipped, failed or uncertain. Discord publication is not batch-atomic.

## Change scope and verification

Implementation reaches the operator CLI, separate first-publication schemas and
planner/apply/reconcile adapter, version-2 manifest validator, create-only Discord
transport, publication repository/snapshot checks, archive writer/service/router
and mock parity, plus tests and operator documentation. Reuse the existing embed
renderer, private-file helper and ownership mechanisms. Do not change the routine
worker into an initial publisher or change the existing PATCH editor's authority.

Required checks include:

- Archived meeting skips before Discord calls or writes; all-skipped batch is a
  successful no-op; unarchiving a skipped row never expands an approved batch.
- Archive before/after preview, claim and submission; production/mock archive
  exclusion; explicit conflict propagation; archive after settled publication.
- Invalid provenance/hash/version, wrong AWS/bot/guild/channel, active lease,
  existing pointers, unresolved owner, missing permissions, timeout and drift.
- Exact approved body and source language, deterministic date/title/link,
  recovered/partial notices, size limits, one-message admission and no pings.
- All-target preflight, exclusive authority across different previews, verified
  rerun with zero writes, response/receipt loss, late POST completion, pointer CAS
  failure and partial-batch stop. Prove no automatic duplicate POST or deletion.
- Known-unsent and definite-rejection settlement, crashed-run approved settlement,
  and refusal to release submitted/uncertain authority on a negative search or
  stopped-run assertion alone.
- Conditional registration/settlement preserves stored content, holds and
  original evidence. Read-only reconcile performs no cloud mutations.
- Existing editor previews/digests, PATCH-only behavior and routine worker tests
  remain compatible. Native Sandbox acceptance uses synthetic data and separate
  execution authority before any production preview/apply.

## Evidence appendix and decision status

Status: proposed design, awaiting approval. No implementation or provider mutation
is included in this task. Implementation details such as helper names and private
receipt key names are left to the builder if they preserve these contracts.

Private investigation evidence and candidate renders:
[read-only report](C:/Users/steve/.codex/visualizations/2026/10/29/01a18814-26d7-7830-9c82-1e74a8a35d53/discord-publication-investigation-2026-11-02T08-57-08-330Z/report.html).
Do not copy its customer text, channel identifiers or provider payloads into this
repository. Customer-specific selection and exact approval digests remain private.

Source references: `recoveryDiscordPublicationTypes.ts`,
`recoveryDiscordPublicationApply.ts`, `recoveryDiscordPublicationStore.ts`,
`recoveryDiscordPublicationBarrier.ts`, `meetingPublicationRepository.ts`,
`types/meetingPublication.ts`, `meetingUpdatePlan.ts`, `meetingUpdateRender.ts`,
`utils/meetingNotes.ts`, `discordMessageEditor.ts`, `db.ts` archive writer,
`meetingHistoryRepository.ts`, `meetingHistoryService.ts`, and
`trpc/routers/meetings.ts`. The guarded legacy importer defines the version-2
manifest and stored-only provenance being published.
