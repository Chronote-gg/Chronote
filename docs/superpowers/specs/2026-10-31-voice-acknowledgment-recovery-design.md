# Recover valid voice acknowledgments without leaving servers stuck

## Review brief

Fix the cases where Chronote receives a valid disconnect acknowledgment but still keeps the server occupied. Accept harmless status updates during disconnect, and finish the original meeting's cleanup when a matching acknowledgment arrives after the initial timeout. Existing recording, preservation, ownership and delivery protections stay in place.

I recommend both repairs together. Fixing only the status-update rejection would leave the late-acknowledgment problem. This proposal does not restart workers, resend voice commands, regenerate notes or change saved meeting content.

**Approved for implementation and tests on October 31, 2026.** A permanently missing acknowledgment or genuinely ambiguous send still requires separately proven stopped-owner recovery. This change cannot safely promise that every Discord failure will automatically unblock a server. Production deployment retains its separate approval.

## What people experience

When a meeting stops, recording stops promptly and processing continues as today. A routine voice status update no longer makes a valid disconnect fail. If Discord's acknowledgment is late, Chronote can finish cleanup automatically once that acknowledgment and the saved-recording evidence are verified. The next meeting can then start in the same server. Existing notes stay on their original messages.

If the old operation cannot be proved finished, Chronote keeps the ownership fence and records a specific operator diagnostic. It must not tell users the server is available while an old operation could interfere with a new recording.

## Evidence and alternatives

A source-only probe runs the actual voice service and pinned SDK with a virtual clock and fake transport/storage. The ordinary sequence settles. Inserting a same-session update naming the original channel makes a subsequent matching null-channel acknowledgment fail, even before the five-second deadline. A matching acknowledgment after the deadline also fails because the first result is cached and its listeners have been removed. This reproduces defects; it does not establish the cause of a particular production meeting.

The existing voice suite passes 15 tests and misses the intervening-status case. A separate assertion against the probe fails with `uncertain` where `settled` is required.

| Approach                                                           | Benefit                                                                    | Limit                                                                                                      | Decision                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------- |
| Fix timely status-update rejection only                            | Small prevention repair                                                    | Late valid acknowledgments still leave permanent holds                                                     | Insufficient alone        |
| Fix rejection and complete late-proof cleanup                      | Recovers valid timely and late acknowledgments without reopening old sends | Truly unprovable operations remain fenced                                                                  | Approved                  |
| Clear after a timer/REST absence, or recycle workers automatically | Could shorten some remaining holds                                         | A timer or current absence does not prove queued sends finished; worker recycling affects other recordings | Excluded from this change |

## Required behavior

### 1. Preserve the exact operation and distinguish timeout from ambiguity

Keep the current bounded `settleOwnedVoiceSession` result for callers. Internally distinguish waiting only for an acknowledgment from transport failure, shard/session/sequence ambiguity, cancellation and persistence uncertainty. A deadline is not itself proof of an ambiguous gateway session.

Once sealed, the SDK connection stays destroyed and all rejoin callbacks stay disabled. Issue at most the existing single leave. No timeout continuation or reconciliation may send a second leave.

While sealed, ignore a monotonic event that names the exact original channel and already-known session. It is neither a leave acknowledgment nor a new join. Unknown/changed sessions, stale sequences, another channel and shard discontinuity keep their existing refusal behavior. A null event received before the original leave is issued cannot acknowledge that leave.

### 2. Observe and persist a later valid acknowledgment

After an acknowledgment-only timeout, retain passive observation for the exact original attempt. A later null-channel acknowledgment is usable only when the connection is permanently sealed/destroyed, the original session and sequence proof match, every submitted transport has actually settled, and no genuine ambiguity occurred. A held/rejected transport cannot become safe merely because a null event arrived.

Serialize the transition against the existing voice record's attempt, meeting, owner and state. Announce eventual settlement only after durable settlement is acknowledged or an exact, consistent readback proves that same requested settlement. Use the repository's existing strong `getRecord` path. Unknown persistence acknowledgment must not poison the write queue and then be blindly replayed; read back first and retain the fence unless the exact result is proved. Changed ownership refuses cleanup.

The first bounded result can remain `uncertain`; callers that need current proof must not keep using that old result as the final authority. Expose eventual verified settlement through one internal subscription or equivalent operation-owned signal. Do not create a dependency from the voice service back into meeting finalization.

Observers and subscriptions are owned by the original attempt, removed on settled completion or terminal ambiguity/disposal, and never duplicate leave sends. Retain only the metadata needed for proof, with no additional audio/transcript copies. An acknowledgment-only wait may remain observed while its original reservation is held; this is one passive observer per held operation, not a timer-driven retry loop. Truly missing proof remains an explicit operator hold.

### 3. Finish the whole release chain

Voice settlement alone is insufficient. Once the original local work is finished, request a fresh bounded reconciliation through `meetingInterruptionService.reconcile`, reusing the existing 30-second reconciliation budget. Do not rerun the cached failed finalization promise or repeat transcription, artifact publication or Discord delivery.

Reuse the current verified checkpoint/history, actual encoder/provider/child/notice lifetimes, nickname cleanup, original reservation checks and conditional lease release. Complete history, including recovery already marked done, must be eligible for this local release proof without changing that history to force recovery discovery. Preserve delivered notes, content revisions, archive choice, capture status and original message IDs.

Cover both orders: voice proof before terminal preservation/recovery and terminal preservation/recovery before voice proof. Actual local-work completion is also a trigger. Coalesce concurrent reconciliations; if a progress event arrives during an older attempt, arrange one fresh attempt after that attempt settles so the event is not lost. Do not spin on an unchanged failed condition. Release the exact original lease and settle its original work handle once; never remove or finish a newer meeting.

For recovered meetings, retain the acknowledged terminal snapshot and use the existing recovered-reservation reconciliation. Recovery nickname preparation stays under its exact renewing recovery lease after actual effects drain; it may run while the acknowledgment alone is pending, but cannot release ownership. Replace stale `work.voice` authority with the current verified proof wherever release or recovered-local cleanup depends on it.

TTS-only reservations use the existing preservation and release proof as well. Preserve bounded stop/cancellation responses and track actual pending effects after a caller's deadline.

### 4. Make remaining holds diagnosable

Record content-free reason and phase for acknowledgment-only waiting, transport failure/timeout, shard/session/sequence ambiguity, persistence uncertainty and changed ownership. Record successful late reconciliation and refused cleanup separately. Use existing operational logging conventions; no notes, transcripts, raw gateway payloads, tokens or new analytics identifiers. This scope adds no new alarm infrastructure or automatic production operation. A missing acknowledgment is reported as an unresolved hold, not silently classified as recovered.

## Acceptance

Use deterministic barriers/fake time, the actual voice service/SDK and real lease/runtime-accounting seams where practical. Provider fakes must preserve conditional-write and unknown-outcome semantics.

1. Timely matching leave still succeeds, including an intervening same-channel/same-session status update. Unknown sessions, other channels, stale sequences and shard changes still refuse.
2. A matching acknowledgment after the initial timeout can settle the original attempt, with one leave, no rejoin and no duplicate settlement publication.
3. Held/rejected sends, deadline cancellation and genuinely ambiguous operations remain owned. Passive observation never manufactures proof.
4. Lost persistence acknowledgment uses consistent readback; an unproved write or changed owner cannot release a lease or counter.
5. Exercise both voice/terminal-recovery event orderings, an event arriving during a coalesced attempt, and actual work finishing after the first reconciliation budget.
6. Prove completed/delivered and recovered meetings release the exact original lease and runtime work handle once, free retained local state, then admit a fresh same-server recording. Verify another reservation and a racing newer meeting remain untouched.
7. Compare canonical meeting content, delivery IDs, revisions, archive and capture metadata before/after. No extra AI, Discord post or Notion call.
8. Retain recording-pressure, unchanged-checkpoint, recovery batching, local recovered cleanup and interruption/cancellation regressions. Run type/build/quality checks and the complete required CI gate.

Sandbox acceptance should exercise a generated authorized fixture through real persistence and the finalization/release chain. Keep simulated gateway evidence separate from an authorized real Discord voice test. No production rollout is authorized by approval of this design alone.

## Engineering reference

Expected change surface: `guildVoiceOperationService`, `ownedMeetingInterruption`, their service tests and fixtures; `activeMeetingLeaseService`/`meetingInterruptionService` only where integration requires it. Add the strong voice-record read to the service's injected repository dependency if needed. Exact internal names and the smallest event-coalescing implementation are builder choices. No DynamoDB schema/index change, infrastructure change, notes-processing change or capacity change is planned.

Authoritative starting point: deployed commit `c5d5f0212bdf663065911fd4539b9b67565c3533`, tree `12823c423b96ed36c48a26eb722760e9a279e1e2`. It contains the emergency recording/capacity repairs and subsequent recovered-history/embed fixes. The repair branch must retain that ancestry and limit its diff to this repair, tests and relevant technical documentation. Unrelated changes in the older checkpoint worktree are outside scope.

Relevant contracts: [deployment handoff](../../deployment-handoff.md), [drain and interruption design](2026-10-12-deployment-drain-and-interruption-design.md), [Discord gateway events](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx), and the repository's pinned discord.js / @discordjs/voice source. The stricter ownership and stale-operation guards are Chronote contracts; do not infer extra ordering guarantees from the Discord documentation.
