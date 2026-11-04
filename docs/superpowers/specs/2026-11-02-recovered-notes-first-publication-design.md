# Repeatable Discord publication of recovered notes

## Review brief

Build a reusable operator workflow: **preview, approve, apply**, with read-only
**status/reconcile** for interrupted runs. After one implementation and deployment,
future supported recoveries use the same commands without a new PR, edited
manifest, hand-built runner or manual verification checklist. Dates and meeting
IDs are selection data, not code.

For the first run, select the three recovered October meetings. Preview notes
for Oct 12 and Oct 13. Automatically skip archived Oct 14 before Discord checks;
its missing Embed Links permission needs no action. Preserve its recovered text,
archive state and publication hold.

This revision replaces the original one-message restriction and per-run deployment
evidence requirement with existing pagination support and automatic runtime
compatibility checks. The exact-content approval, concurrency protection and
no-duplicate-send requirements remain.

Confirmed requirements:

- Archived meetings do not need publication. Never unarchive them or repair their
  Discord permissions for this workflow.
- Preserve approved text, language, uncertainty and partial-capture outcomes.
- Reuse the guarded publication machinery and make routine checks automatic.
- Keep production read-only during this task. Design approval is not production
  deployment or publication approval.

Recommended defaults for approval with this design:

- Publish notes only, without a summary or separate announcement.
- Keep automatic delivery and Notion held after this one-time publication.
- Exclude archive/unarchive while publication is running or unresolved. An archive
  request receives a retryable conflict rather than racing a submitted send.

The material tradeoff remains: an uncertain send can block archive changes. If
both its message ID and independent provider evidence are lost, that block may
be indefinite. A PR cannot establish missing provider evidence; there is no
force-clear or automatic resend.

## Operator workflow

Add explicit `first-publication` mode to the existing operator CLI. Proposed
command shapes, with final flag spelling left to implementation:

```text
first-publication preview --environment production --selection PRIVATE_SELECTION --out PRIVATE_DIRECTORY
first-publication apply --preview PRIVATE_PREVIEW --expect-sha256 APPROVED_DIGEST
first-publication status --preview PRIVATE_PREVIEW
first-publication reconcile --preview PRIVATE_PREVIEW --out PRIVATE_DIRECTORY
```

An installed environment profile selects account, region, tables, bucket and
archive-writer services. A selection contains meeting keys or an existing recovery
bundle reference, and can be generated from recovery output. Do not require the
operator to retype provider scope, assemble hashes or copy message IDs. Support
1 to 25 meetings per batch, with larger selections split into ordinary batches.

| Step             | Operator action                                      | Automatic work                                                                                                  | Result                                                                   |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Preview          | Select recoveries and run one command                | Skip archives, validate supported provenance, check source/access/prior publication/runtime, render exact posts | Human review and machine-readable plan                                   |
| Approve          | Review posts, destinations, skips and record changes | Bind exact plan bytes to one digest                                                                             | Approval of that plan                                                    |
| Apply            | Run the saved plan with its approved digest          | Recheck mutable facts, claim ownership, send, verify and register IDs                                           | Per-meeting results and private receipts                                 |
| Status/reconcile | Run one read-only command after interruption         | Inspect durable intent, Discord and history                                                                     | Verified/no-op, actionable blocker, or an approval-ready resolution plan |

Preview/status/reconcile write only owner-only local artifacts. They do not create
cloud previews, claims or receipts, release holds, invoke a worker or send messages.
Apply is the only mutating operation. Approval is the operator's decision, not a
new approval-storage service or a manually maintained evidence bundle.

Successful output is compact: published, already published, skipped, blocked and
uncertain counts, plus message links or one concrete next action. Detailed evidence
stays private. Stable machine-readable outcomes support later automation. An
all-archived or verified all-already-published run succeeds with zero provider
writes and does not require a mutating runtime capability check.

An eligible blocked row makes the batch non-apply-ready. Do not quietly omit it.
The operator may explicitly preview a new selection excluding that row. Archive
skips and verified prior publications are normal automatic omissions, recorded
in the plan. Apply never expands the approved selection.

## Normal blockers and remedies

| Result                                     | Remedy                                                                 | New PR?                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `skipped_archived`                         | None; leave stored-only                                                | No                                                        |
| `already_published`                        | None after automatic verification                                      | No                                                        |
| Missing channel permission                 | Server owner fixes access, then rerun preview                          | No                                                        |
| Content/archive/destination drift          | Refresh preview and approve the changed plan                           | No                                                        |
| Runtime unavailable or mixed deployment    | Wait for a compatible stable deployment, then rerun                    | No                                                        |
| Verified message missing saved pointers    | Reconcile generates a conditional finalization plan; approve/apply it  | No                                                        |
| Known-unsent abandoned owner               | Reconcile generates a conditional release plan; approve/apply it       | No                                                        |
| Uncertain send without sufficient evidence | Investigate and keep blocked; never infer absence from an empty search | No automatic remedy; code changes do not prove an outcome |
| New provenance format or a tool defect     | Add a supported adapter or fix with tests                              | Yes                                                       |

These are command outcomes, not a checklist for an agent to perform manually.
Run independent reads together and reuse results within each phase. Preview
validates immutable source objects; apply checks the approved payload and current
mutable source bindings. Do not replay audio, regenerate notes or repeat unrelated
historical investigations. New source bindings require a new preview.

## Approaches and scope

| Approach                                            | Tradeoff                                                                  | Decision                          |
| --------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| Reusable first-publication operator mode            | Adds initial POST handling while reusing previews, ownership and receipts | Selected by the design discussion |
| Expand the routine worker into an initial publisher | Broadens background behavior beyond exact operator approval               | Deferred                          |
| Manual send or repurpose the start embed            | Loses durable duplicate protection or overwrites historical controls      | Rejected                          |

Keep existing editor schemas, preview digests and PATCH-only authority unchanged.
Use discriminated first-publication schemas and a create-only transport. Accept
the version-2 provenance produced by the recovery importer without inventing old
transcript keys, notes versions or an original apply timestamp. New format support
is an explicit adapter, not a collection of permissive fallback guesses.

No new portal pages or navigation are needed. Existing portal links and operator
preview flow are reused, so external UX reference research is unnecessary here.

## Recipient presentation

Use the existing notes renderer, pagination and message batching for any supported
notes length within existing limits. Longer notes are a normal case, not an
implementation exception. Every message/page and its order is bound to approval.
Current October notes each fit in one message.

The title identifies recovered notes and the original meeting UTC date/time. Keep
the exact approved body, original language, recovered version footer, interrupted
capture prefix, unknown coverage/end notices and partial-transcription warning.
Include a link button to the existing portal route for this meeting. Bind title,
embeds, components, links and `allowed_mentions: { parse: [] }` in the exact plan.

Do not invent an end time/duration or add a summary, pings, recording/correction
controls, attachments or separate announcement. Preserve original start posts and
unrelated messages. The stored destination is authoritative; this mode cannot
silently select another channel.

## Eligibility, binding and duplicate protection

Read selected rows consistently. A valid archived row is skipped before Discord
calls, source-artifact validation or publication claims. Absent `archivedAt` means
unarchived under the existing contract; malformed archive data is a data error.
Freeze skip identities in the preview. Later unarchiving cannot expand that plan.
Later archiving of an eligible row invalidates it before send and requires refresh.

For eligible rows, validate account/environment, meeting and recovery identity,
manifest path/row linkage, notes version, notes/transcript hashes, real preparation
time, nullable prior artifacts, language/classification and partial/unknown facts.
Verify approved notes against their immutable object. Bind content/delivery
revisions, destination, archive state, capture/coverage, warnings and transcript
pointer. Require interrupted lifecycle, no active target lease, no unsettled
original publication and the expected stored-only hold.

Check durable publication identity and registered pointers before treating absent
pointers as first-publication eligibility. Matching verified prior publication
returns `already_published` through a read-only path. Otherwise block existing
pointers, unresolved owners or retained update attempts/candidates for reconciliation.

For new publication, verify bot identity, destination guild, ordinary text-channel
type, View Channel, Read Message History, Send Messages, Embed Links and no active
member timeout. Permission checks do not prove a future send will succeed.

Use a bounded history search as supporting duplicate evidence for legacy records.
An original start post can anchor the search but is optional for future recoveries.
Only exact meeting linkage is authoritative; proximity or similar text cannot
justify adoption or editing. Ambiguous candidates block publication. Show search
bounds privately; do not require exhaustive channel history or unrelated customer
meeting reads as a routine prerequisite. New evidence affecting eligibility needs
a refreshed preview, not silent adoption.

## Automatic runtime compatibility and archive exclusion

Implement and deploy the archive guard once, with separate deployment authority
and synthetic Sandbox acceptance. Future runs check it automatically, without a
human collecting rollout evidence or approving a separate prerequisite file.

The environment profile identifies all supported archive-writer services. Release
metadata shipped with the tool maps immutable image digests to the versioned
`first_publication_archive_fence_v1` contract. Through the existing AWS route,
preview/apply inspect every running/replacing task in those services. All must be
known compatible and in a stable serving generation. Unknown digest, legacy task,
changing cohort or unreadable deployment yields an actionable runtime blocker.
A load-balanced health response, arbitrary version string or copied boolean is
insufficient. Release metadata is updated with normal releases, never per meeting.
An old tool can report a newer unrecognized build as requiring a tool update;
installing a supported operator release is not a new recovery PR.

Apply repeats compatibility checks before acquisition and submission. The archive
fence is a backward-compatible deployment contract: later deployments retain it,
and incompatible rollback cannot overlap unresolved publication. Enforce that in
the deployment compatibility check, not a manual per-run operator step.

Serialize incompatible deployment against publication through the existing
environment deployment-control record. Acquisition atomically adds a durable
publication-run pin to that record and claims the meeting row, conditioned on
the observed stable generation and no incompatible transition. The deployment
coordinator must reserve an incompatible transition on the same record before
changing any runtime, conditioned on zero publication pins. A reserved transition
blocks new pins. Whichever transaction commits first excludes the other; a fresh
cohort read alone cannot supply this guarantee. Compatible releases retaining the
contract need not wait for pins. Retain pins through uncertainty; release them
transactionally with the last settled row for that run, not through TTL expiry.
Use one pin per run with its selected meeting set and settled count; retries are
conditional and idempotent. All supported rollout/rollback entry points must use
this reservation, with production/mock parity and initial acceptance tests.
Direct infrastructure changes bypassing the coordinator are outside the supported
guarantee. This uses the existing control table, not a new service or manual gate.

Serving runtime verification is part of initial acceptance; this task authorizes
none of that deployment work.

Include archive fields, destination, capture/coverage and transcript pointer in
first-publication conditional acquisition/ownership binding. Preserve legacy
preview digest compatibility with a separate versioned binding. The archive
writer in `src/db.ts` and its mock must condition archive/unarchive on no running
publication repair owner. Propagate explicit retryable conflict through the
repository/service/tRPC call, not a misleading not-found response.

- Archive commits first: publication acquisition fails, so no POST occurs.
- Publication claims first: archive conflicts until publication settles.
- Source/ownership drift before submission: stop without a POST.
- Submitted or uncertain request: keep authority until resolved, preventing an
  acknowledged archive operation from racing late completion.

After settlement, archiving works normally and does not delete existing posts.
Out-of-band database edits bypassing supported writers are outside this guarantee.

## Apply, persistence and interrupted runs

Apply accepts a saved ready plan and exact approved digest. Regenerate its payload
from bound data, refresh mutable bindings, permissions, compatibility and duplicate
evidence, and preflight every eligible row before the first mutation. Drift stops
the batch; never silently send a subset under a different plan.

Use the common exclusive publication owner to fence canonical updates and worker
delivery. Keep stable authority per meeting/recovery/version, independent of
preview digest. New previews cannot bypass an unresolved or successful previous
attempt. Preserve immutable attempt/receipt history beneath that authority.

Process meetings and their planned messages sequentially. Durably record exact
payload hash and submission intent before every POST, revalidate ownership and
mutable guards, then invoke a create-only GET/POST transport with safe mentions,
no redirects, no automatic retries and bounded request timeout. It exposes no
PATCH or DELETE operation.

Persist each returned message ID and GET it. Verify exact normalized payload,
channel, bot author and absence of webhook ownership. Keep verified page IDs in
durable receipts. Only when every planned page verifies, conditionally register
`notesChannelId` and ordered `notesMessageIds`, acknowledge the captured notes-body
revision and settle the owner in one DynamoDB update. Require exact owner/source,
absent pointers and unchanged captured revisions. Strong readback precedes a
verified result.

Use a dedicated repository settlement operation; the existing repair repository
cannot register pointers. Preserve notes/version, transcript, archive state,
original lifecycle/delivery evidence and import provenance. Leave automatic
publication held for `stored_only`, acknowledge current published notes-body work
and mark its progress synced. Keep Notion and separate notification status held.
The publication receipt records this new delivery without rewriting import history.

For a current run with positive evidence that POST was never invoked, or an
unambiguous rejecting provider response, a conditional no-publication settlement
can retire its exact owner while leaving content, pointers and holds unchanged.
Submitted/uncertain evidence cannot be erased by that operation. After process
loss, run reconciliation first; it never writes to production.
This settlement is valid only when no page succeeded and every invoked request
is positively rejected, with no unresolved submission. Once any page has been
published, retain the owner and deployment pin for finalization or continuation;
a later page's definite rejection does not make the meeting unpublished.

Reconcile produces the same reviewable plan format, accepted by the same apply
command, with typed operations:

- **Finalize verified publication:** register already verified message IDs and
  settle only, with no Discord sends.
- **Release a known-unsent attempt:** conditionally settle an exact stopped owner
  with positive no-send/rejection evidence, preserving its receipts.
- **Continue a partially published meeting:** bind verified page IDs and send only
  positively unsent remaining pages after fresh approval. Never resend verified
  pages or proceed past an uncertain page.

After process loss, transferring authority for any resolution or continuation
requires positive confirmation that the exact previous run stopped, plus a
conditional compare of its owner and receipt state. A local stale heartbeat alone
cannot prove it stopped. Keep the stable authority and deployment pin across the
transfer; do not briefly release either between runs.

Each resolution binds exact before-images and positive evidence. It needs explicit
approval of its digest, not a new script or PR. A clean verified rerun does only
reads. A new attempt after known-unsent settlement uses a new generation under
the same stable authority and preserves earlier evidence.

A timeout, lost response, unknown database outcome or uncertain receipt stops the
batch. Never automatically retry a POST, release authority, delete a message or
undo successful earlier meetings. If IDs are known, reconcile through exact GETs.
Without IDs, content matching or a negative search is insufficient. Resolution
requires independent positive message-ID evidence, such as a retained response or
request trace, followed by exact GET verification and confirmation the prior run
has stopped. Without it the outcome remains uncertain, even for a stopped run.
No force-release or new provider correlation protocol is included in this design.

Report per-meeting verified, skipped, failed or uncertain results. Discord sends
are not batch-atomic. Partial successful pages remain recorded for safe continuation.

## Implementation, acceptance and deferred work

One implementation reaches the existing operator CLI, first-publication schemas,
source adapter, planner/apply/status/reconcile, create-only transport, conditional
publication registration and archive writer/service/router/mock parity. It also
adds maintained environment/release compatibility metadata and automated checks,
and the deployment compatibility guard against an unsafe archive-writer rollback.
Reuse existing renderer, batching, private-file helper, ownership and receipts.
Do not turn the routine worker into an initial publisher or widen the old editor.

Required tests/acceptance:

- Reuse the same commands for future synthetic meetings, languages and paginated
  notes, without code/config changes for each meeting.
- Archived and all-archived selections skip Discord calls and writes; verified
  prior publication is a no-op; unarchiving never expands approved scope.
- Normal permission, unavailable/mixed runtime and drift blockers have stable
  outcomes and tested recovery paths through refreshed preview.
- Automatic compatibility covers the full archive-writer cohort, replacement,
  unknown builds and tool-release updates. Interleave publication acquisition
  with incompatible deployment reservation to prove mutual exclusion and pin
  retention through partial/uncertain work, including all supported entry points.
- Archive-before-claim and claim-before-archive interleavings hold in real/mock
  repositories; tRPC returns conflict, and settled publication permits archive.
- Validate provenance, hashes, ownership, leases, source bindings, notices, exact
  content, pagination, ordering, limits and safe mentions.
- Test concurrent previews, verified reruns, multi-page partial sends, late POST
  completion, lost responses/receipts and conditional registration conflicts.
- Reconcile is read-only. Its finalize/release/continue plans require exact approval
  and perform only their declared operations. Negative searches never authorize
  resending or releasing uncertain work.
- Existing editor digests/PATCH authority and routine worker behavior stay
  compatible. Synthetic Sandbox acceptance proves the installed command workflow
  and serving archive guard before any separately approved production use.

Deferred: arbitrary provenance conversion, new destination selection, summaries,
Notion release, automatic future delivery, portal UI, notifications, force-clear
and forensic recovery without positive provider evidence. New unsupported formats
and genuine defects justify code changes; everyday recovery cases do not.

## Evidence appendix and decision status

Status: revised proposal, awaiting design approval. No product implementation,
provider mutation, deployment or publication is included in this task.

The November 2 read-only investigation confirmed two eligible unarchived October
meetings, one archived meeting, approved notes version 2, holds and absent saved
notes/summary pointers. Each had a surviving start post. Nearby Oct 12 notes were
proved to belong to other completed meetings. Those observations are dated and
must be refreshed automatically, not treated as permanent operational truth.

Private evidence and candidate rendering:
[read-only report](C:/Users/steve/.codex/visualizations/2026/10/29/01a18814-26d7-7830-9c82-1e74a8a35d53/discord-publication-investigation-2026-11-02T08-57-08-330Z/report.html).
Do not copy customer text, identifiers or provider payloads into this repository.

Source reference: existing `recoveryDiscordPublication*` modules and CLI,
`meetingPublicationRepository.ts`, `types/meetingPublication.ts`,
`meetingUpdatePlan.ts`, `meetingUpdateRender.ts`, `utils/meetingNotes.ts`,
`discordMessageEditor.ts`, the archive writer in `db.ts`,
`meetingHistoryRepository.ts`, `meetingHistoryService.ts`, and
`trpc/routers/meetings.ts`. The guarded recovery importer owns the supported
version-2 source format. Helper names are builder choices within these contracts.
