# Voice acknowledgment recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Accept valid timely and late disconnect acknowledgments and release the exact original session without losing recording work or changing delivered notes.

**Architecture:** Keep the existing bounded settlement API, with a separate shared signal that resolves only after eventual verified durable voice settlement. Original-session interruption cleanup consumes that signal and reuses existing bounded preservation/reconciliation, conditional lease deletion and runtime accounting. Unknown external effects remain fenced.

**Tech Stack:** Existing TypeScript, Node.js 24.22.1, discord.js/@discordjs/voice, DynamoDB repository, Jest.

**Spec:** [Approved voice acknowledgment recovery design](../specs/2026-10-31-voice-acknowledgment-recovery-design.md).

## Global constraints

- Base: deployed `c5d5f0212bdf663065911fd4539b9b67565c3533`; retain all recording, recovery, history, delivery and capacity fixes in its ancestry.
- Preserve `settleOwnedVoiceSession(reservation, options?): Promise<"settled" | "uncertain">` and `waitOwnedVoiceEffects(reservation): Promise<void>` semantics.
- At most the original single leave; never reconnect, resend after timeout, or use REST absence/elapsed time as settlement proof.
- No schema/index, infrastructure, capacity, AI, publication or production changes. Approved scope is implementation and tests.
- Keep actual effect lifetimes counted after bounded deadlines. Preserve notes, transcript/audio pointers, revisions, archive/capture state and message IDs.
- Use existing dependencies, strong repository reads and exact original-attempt ownership checks. No new dependency or generic event framework.

## Review focus

- A status update before the leave is issued must not make a later null event acknowledge an unissued leave: Task 1.
- A matching ACK while the leave transport remains held must not resolve eventual proof until actual transport settlement: Task 1.
- A lost write response with an old/different settled row must not manufacture ownership proof: Task 1.
- Voice/recovery/work completion arriving during coalesced reconciliation must receive one fresh bounded attempt without a retry loop: Task 2.
- A newer meeting occupying the guild must survive late original-session cleanup with its own counter untouched: Task 2.

## Files and responsibilities

| File                                                                                                                                             | Responsibility                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `src/services/guildVoiceOperationService.ts`                                                                                                     | Classify status events and soft ACK waits, durable eventual settlement, diagnostics                                 |
| `test/services/guildVoiceOperationService.test.ts`                                                                                               | Real SDK/service ordering, persistence uncertainty and refusal regressions                                          |
| `src/services/ownedMeetingInterruption.ts`                                                                                                       | Eventual-proof triggers, fresh cleanup proof and both recovery orderings                                            |
| `src/services/meetingInterruptionService.ts`                                                                                                     | Only if needed for progress arriving during an in-flight reconciliation                                             |
| `src/services/activeMeetingLeaseService.ts`                                                                                                      | Only if needed for exact original reservation release integration                                                   |
| `test/services/ownedMeetingInterruption.test.ts`, `test/services/recoveredOwnedMeeting.test.ts`, `test/services/recoveredLocalAdmission.test.ts` | Preservation/recovery ordering and accounting regressions                                                           |
| `test/services/lateVoiceSettlement.test.ts`                                                                                                      | Composed actual voice-service, session cleanup and fresh-admission proof if existing fixtures cannot cover the seam |
| Existing stop/interruption fixtures and mocks                                                                                                    | Supply the new eventual-proof signal with faithful timing                                                           |

## Task 1: Preserve valid acknowledgment proof

**Owner:** fresh voice-service implementer. Files: voice service and its service test only. Update no integration caller or shared fixture yet.

**Interfaces:** Consume repository `writeVoice` and strong `getRecord(pk: string, sk: string): Promise<DeploymentControlRecord | undefined>`. Produce factory and singleton `whenOwnedVoiceSettled(reservation: SessionReservation): Promise<void>`, shared per exact operation, resolving once only after local proof and durable settlement. Repeated existing `settleOwnedVoiceSession` calls return `settled` through the existing settled-reservation fast path after that proof. Missing/foreign operations must not produce a resolved proof. The new signal is separate from transport/write draining.

- [x] Add a failing real-SDK test: same-channel/same-session monotonic update between sole leave and null ACK still yields `settled`; one leave, no rejoin.
- [x] Add failing late-ACK tests: first five-second result is `uncertain`; eventual signal remains pending; exact late ACK resolves it once after sends drain; repeated settlement then returns `settled` and listeners are removed.
- [x] Add refusal tests for wrong/unknown sessions, stale sequence, other channel/shard, send rejection/hold, abort before leave, ACK before leave and fake remote settlement without local proof.
- [x] Add persistence tests: applied CAS; lost response confirmed by exact strong readback; unchanged/nonmatching/unknown readback retains ownership; stale owner refuses; no poisoned write chain or blind replay.
- [x] Run tests red before production edits, using pinned Node and `node_modules/jest/bin/jest.js --runInBand --coverage=false test/services/guildVoiceOperationService.test.ts`.
- [x] Implement the smallest operation-local state distinction and shared eventual-proof promise. Preserve first bounded disposition; keep observation only for recoverable ACK-only waiting; all actual sends/writes remain tracked. Resolve proof and remove the operation/listeners only after durable success. Add content-free reason/phase diagnostics.
- [x] Run the complete voice suite green, type-check affected interfaces, self-review and commit only owned files. Supply red/green evidence and exact interface semantics to Task 2.
- [x] Independent task review checks spec compliance and concurrency/ownership quality; resolve important findings before Task 2.

## Task 2: Release the original session after late proof

**Owner:** fresh integration implementer, after Task 1 review. Files: interruption/lease integration, tests and affected mocks/fixtures.

**Interfaces:** Consume Task 1 `whenOwnedVoiceSettled` plus existing settlement/drain APIs. Reuse `meetingInterruptionService.reconcile(meeting, deadline, run)` and existing preserved/recovered reservation reconciliation. Use the existing 30-second fresh reconciliation budget.

- [x] Add failing tests for completed/delivered history with recovery done: initial voice wait returns uncertain, later verified proof triggers actual original cleanup without regeneration/history edits, releases the exact lease/work handle once, frees local retained state and permits a fresh same-guild reservation.
- [x] Add failing tests for voice-before-recovery, recovery-before-voice, delayed actual local work, and a progress event during an older coalesced reconciliation. A second event must cause one fresh bounded attempt; an unchanged failed condition must not loop.
- [x] Add a stale/new-owner test preserving another meeting, its lease/counter and canonical original content. Assert no extra AI, Discord post or Notion effect. Cover TTS-only release.
- [x] Run those tests red before integration changes. Use the actual voice-service factory plus lease/runtime-accounting implementation in at least one composed test; fake only external providers and preserve CAS/unknown-outcome semantics.
- [x] Register one eventual-proof continuation for the original stopped reservation. Use current settlement proof in release/recovered-local checks, not the cached first `work.voice` value. Reconcile only after actual local work finishes; never rerun the failed finalization promise.
- [x] Reuse existing checkpoint/history/notice/child/nickname checks. Allow recovery nickname preparation under its exact renewing recovery lease after actual effects drain while ACK alone remains pending; this preparation never releases ownership. Handle the retained acknowledged recovery snapshot after recovery ends.
- [x] Coalesce progress-triggered attempts, including an event arriving while another attempt runs. Ensure exact cleanup and work-handle settlement occur once. Keep genuinely unknown effects held and diagnostic; no new background polling framework.
- [x] Run integration regressions green, fix all mocks/fixtures for the new signal, self-review and commit only owned files.
- [x] Independent task review checks exact release proof, both event orderings, unknown effects and canonical content preservation; resolve important findings.

## Combined verification and delivery

- [ ] Run focused voice, lease, interruption, recovered-local admission and end-meeting tests together, then type-check, build, lint and formatting checks appropriate to changed files.
- [ ] Run existing recording-pressure, unchanged-checkpoint, recovery batching and cancellation regressions. Run the full required local/CI suite once; retain actual terminal results and any limits.
- [ ] Inspect the final diff from deployed C5. It must contain only this repair, tests/fixture updates and technical documentation. Verify capacity and earlier recording source remain intact.
- [ ] Fresh whole-branch review covers the composed lifecycle and cross-file races; address important findings and recheck affected tests.
- [ ] Record whether Sandbox persistence/real voice acceptance ran. Missing Docker, unavailable Sandbox fixtures or absent real Discord voice evidence are explicit limits, not passing acceptance.
- [ ] Prepare exact sanitized PR title/body and request only the publication approval required by repository rules. Do not push/publish/merge/deploy under implementation approval alone.

## Execution notes

The user has already selected subagent assistance and approved this design for implementation/tests. This plan records the execution details; it introduces no additional approval gate. Fresh implementers own disjoint task scopes sequentially, with independent review after each and at completion. The coordinator owns plan/ledger updates and combined verification.

Working shell route after default-shell stalls: explicit Windows PowerShell, `login: false`, owning-user execution; pinned Node path is recorded in the private local operator evidence. Do not alter shell profiles or integrations for this repair.
