# Voice process-exit fix implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep recoverable voice capture failures from terminating the bot, and include a proven pending-DAVE input guard in the same PR when its safety gate passes.

**Architecture:** Dispose subscriptions with error handling intact and consume rejections at the recoverable callback boundaries. Optionally validate pending protocol frames immediately before Opus decoding, using each input's immutable receiver snapshot and preserving incomplete-capture reporting.

**Tech stack:** TypeScript, Node streams, Jest, discord.js, pinned voice/Davey integrations and native Opus.

**Spec:** [Human review brief and design](../specs/2026-10-14-voice-process-exit-design.md).

## Global constraints

- Subagent implementation was approved on October 14, 2026, including the DAVE guard in the same PR only if its stated tests pass. Merge and production deployment remain separately authorized actions.
- Keep the existing 250 ms resubscription timing; add no new retry budget or backoff policy.
- Preserve usable partial transcript processing, generated notes and the current incompleteness notice. Never clear captureIncomplete after recovery.
- Use attributed immutable per-input diagnostics, including queued writes, for any DAVE decision.
- No media retention/buffering, production replay, broad debugging, dependency upgrades or MLS negotiation changes.
- New markers contain only approved scalar metadata and meeting correlation. No participant IDs, payloads, packet sizes, arbitrary error text or secrets.
- Startup/login sequencing, fatal instrumentation and capture/history recovery are deferred.
- Node 24.15.0 Linux/native Opus verification is required for the optional DAVE behavior. Windows/OpusScript controls alone are insufficient.

## Review focus

- Aliased decoder/decoded streams are disposed once and cannot lose a queued error consumer. Task 1 tests this.
- Late errors/data after cleanup cannot create a replacement or write capture data. Task 1 tests this.
- A member leaves or a newer subscription replaces the old one before its timer fires. Task 2 tests this.
- Plaintext has a footer-like suffix, or the receiver snapshot is missing. Task 4 preserves its current path and tests this.
- A queued input has a not-ready snapshot although the latest connection is ready. Task 4 uses the input snapshot and tests this.

## Execution preparation

- [ ] After approval, inspect attached worktrees and current remote master. Use a suitable clean managed worktree with the using-git-worktrees skill; do not restore the removed checkout or change another chat's worktree.
- [ ] Copy this plan and its spec into the execution worktree. Read its current AGENTS.md and relevant directory instructions. Check the recovery work for overlap before changing shared voice code. Preserve that chat's ownership and messaging approval requirements.
- [ ] Reconfirm the reproduced boundaries against the new base. Carry forward the accepted DAVE probe and decrypt/control patch hunks. The only additional library change is the Task 1 receiver-close identity guard.

## Task 1: Make subscription disposal safe

**Files:** [Task 1 file map](#task-1-file-map) in the appendix.

**Interfaces:** Produce disposeVoiceStream(stream: Readable, detachOwnedListeners: () => void): void. Keep clearVoiceSubscription(meeting: MeetingData, userId: string): void private. Store owned listener cleanup with a live subscription rather than removing every listener on a stream.

- [ ] Write failing tests for destroy(error) queued before cleanup, the shared decoder/decodedStream alias, repeated cleanup, emitClose=false, externally owned listeners and late PCM/end/error callbacks. Assert no unhandled error, one destroy per distinct stream, no replacement timer and no post-cleanup capture writes.
- [ ] Build a child case that exercises the actual production disposal path with real Node streams and injected faults. Select private functions by TypeScript AST name if module isolation is needed, rather than copying bodies or depending on line numbers. Child output is fixed result markers only. Assert exitCode=0 and teardownCompleted=true for the formerly fatal pending-error case.
- [ ] Run: yarn test --runInBand --runTestsByPath test/utils/disposeVoiceStream.test.ts test/audio/voiceSubscriptions.test.ts test/audio/processExit.test.ts. Confirm the baseline fails for the queued-error/alias cases rather than unrelated setup.
- [ ] Implement idempotent error-safe disposal. Attach the teardown error consumer before detaching owned handlers; unpipe and destroy once; release the guard after close. Use weak ownership for disposal tracking. Suppress recovery and cancel the timer before teardown, and delete only the receiver entry that still points to the old stream.
- [ ] Rerun the focused command and the existing successful error/resubscription cases. Assert streams and timers return to baseline after repeated create/dispose cycles. Do not keep a process alive through a global exception handler.
- [ ] Commit the complete teardown change with its tests.

## Task 2: Contain recoverable voice callback failures

**Files:** [Task 2 file map](#task-2-file-map) in the appendix.

**Interfaces:** Keep `subscribeToUserVoice(meeting: MeetingData, userId: string): Promise<void>` and `handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void>`. Consume their rejections at registered callback/timer boundaries. Notification send remains a best-effort Promise owned by its connection error callback.

- [ ] Write failing cases for receiver.subscribe throwing, decoder construction throwing after a receiver stream exists, pipe setup throwing, a rejected voice-state subscription and a rejected textChannel.send. Assert partial resources close, active capture is marked incomplete where applicable, exactly one sanitized failure marker appears, and no unhandled rejection remains.
- [ ] Add stale timer cases for departure, finishing, destroyed connection and replacement by a newer subscription. Assert the old timer makes no new subscription and its cleanup never deletes the new one. Pin the unchanged 250 ms timing and absence of an added automatic retry loop after construction failure.
- [ ] Extend child survival controls for timer receiver/decoder construction failures. Assert exitCode=0 and callbackFailureHandled=true. Retain the ordinary handled decoder recovery control as a comparison.
- [ ] Run: yarn test --runInBand --runTestsByPath test/audio/voiceSubscriptions.test.ts test/audio/processExit.test.ts test/bot.voiceFailureBoundaries.test.ts test/meetings.voiceFailureBoundaries.test.ts. Confirm the baseline failures reflect uncaught/rejected work.
- [ ] Clean up partially constructed subscription resources before rethrowing to awaited callers. Catch the timer rejection and the registered voice-state callback rejection. Catch the notification rejection without recursively sending another notice. Use fixed stage enums, with no arbitrary exception/message/state dumps. Suppress stale cleanup and logging against a newer subscription.
- [ ] Rerun the focused command, including awaited initial-subscription behavior and unchanged graceful/fatal startup comparison controls. A runtime operation is contained; a failed startup is still fatal.
- [ ] Commit the callback-boundary change separately from Task 1.

## Task 3: Establish the DAVE inclusion gate

This task can run independently of Tasks 1-2. It produces test evidence, not a production DAVE change. If the gate fails, document why, retain the process-exit commits and skip Task 4. Do not stall the process fix on speculative MLS work.

**Files:** [Task 3 file map](#task-3-file-map) in the appendix. Keep any native fixture generator/build output out of the production image. Reuse the existing real CJS/ESM receiver harness where suitable.

**Interfaces:** The harness owns two matching native test sessions and their cleanup. Tests exercise their real welcome/commit/decrypt methods, not stub MLS methods. It produces a scalar proof result and test inputs held only for the duration of the test. No application API is introduced by this task.

- [ ] Create initial and reset controls with fresh synthetic keys and signed proposals for the actual two members. Assert a valid welcome joins the receiver, native readiness becomes true after the expected control processing, and a sender frame authenticates and decrypts to the exact original test Opus input.
- [ ] Assert delayed controls leave native pending, then activate that same receiver without a voice resubscription. Cover both initialization and decrypt-failure reinitialization with both reply wrappers returning. Keep Resuming suppression as a comparison, not the assumed production cause.
- [ ] Establish an independent pinned native frame-parser oracle and positive/negative vectors. Record whitepaper/native discrepancies explicitly. No wrong-sender rejection, footer detection or Opus decode result is an authentication substitute.
- [ ] Run: yarn test --runInBand --runTestsByPath test/audio/daveActivation.test.js test/audio/daveResetDiagnostics.test.js test/audio/daveResume.test.js test/audio/receiveDiagnostics.test.js. Require successful real welcome and authenticated decryption in both runtime distributions.
- [ ] Evaluate feasibility before proceeding. If a new production native API, dependency version, runtime Rust component or unavailable synthetic signing/activation harness is necessary, mark the gate unmet and leave DAVE behavior out of the PR. A separate development-only generator is allowed if its scope is small and reproducible.
- [ ] Commit successful fixtures/tests and summarize the gate result. Do not describe source-level or local proof as the production root cause.

## Task 4: Guard pending DAVE input before Opus, if Task 3 passes

**Excluded after Task 3 evaluation on 2026-10-14.** The [measured DAVE gate result](../specs/2026-10-14-dave-inclusion-gate.md) found native parser disagreement with the approved structural bounds. Authenticated two-member proof remains unperformed. Keep the process-exit work and do not implement the following conditional task in this PR.

**Files:** [Task 4 file map](#task-4-file-map) in the appendix. No voice patch or manifest change is intended.

**Interfaces:** Produce hasDAVEProtocolFrameStructure(packet: Uint8Array): boolean, a bounded, nonthrowing structural check that neither authenticates nor retains its input. Extend the internal OpusDiagnosticDecoder constructor with an optional synchronous onPendingDAVEInput(diagnostics: ReceiverDiagnostics): void callback. ReceiverDiagnostics remains derived from VoiceReceiver.packetDiagnostics. _transform continues using its existing signature and callback contract.

- [ ] Write classifier tests for native positive vectors; genuine plaintext and silence; footer-like plaintext; supplemental size bounds; truncated/overflowing ULEB128; incomplete, unsorted, duplicate or overlapping ranges; and ranges past the media portion. Pin the intended rules against the Task 3 oracle. Return false without throwing for malformed inputs. Document the rare structurally matching plaintext risk.
- [ ] Write decoder integration tests that spy on the actual codec call. For attributed protocol-1/not-ready/native-false structural frames, assert zero codec calls, zero PCM, a completed transform, unchanged stream liveness and captureIncomplete=true. Repeated skips keep marking capture loss but produce at most one DAVE pending input skipped: marker per decoder. Assert the marker contains no participant or packet data.
- [ ] Test plaintext/silence, protocol-zero, native-ready, native-decrypted and missing-snapshot inputs through the existing path. Cover queued not-ready input after the latest native state changes, followed by an authenticated post-activation frame on the same stream. Inject a throwing drop callback and assert a handled stream error, not an uncaught exception. Late callbacks after cleanup do nothing.
- [ ] Run: yarn test --runInBand --runTestsByPath test/utils/daveProtocolFrame.test.ts test/audio/voiceSubscriptions.test.ts test/audio/receiveDiagnostics.test.js test/audio/daveActivation.test.js. Confirm the guard expectations fail on the old decoder before implementing the behavior.
- [ ] Implement the pure classifier and the pre-codec decision using only the input snapshot. Complete intentional skipped transforms without invoking Opus. Invoke the capture-loss callback safely and preserve existing failed-input correlation for real codec errors. Keep the stream open; add no buffering, native decrypt calls or MLS resets.
- [ ] Run yarn build and yarn docker:build. Then run: docker run --rm --network none --entrypoint node meeting-notes-bot-ci test/audio/fixtures/runDAVEActivationGate.cjs. The harness must force @discordjs/opus, assert Node 24.15.0/Linux, authenticate the two-member native round trip and output only scalar pass results. Use a separate validation image or mounted development fixture generator if needed, without putting it into the production image. If this proof cannot be obtained, remove the DAVE behavior commit from this PR.
- [ ] Commit the gated DAVE change separately. Its claim is pending-input protection, not repair of all MLS/reconnect failures.

## Whole-branch verification and PR handoff

- [ ] Run the focused suites, yarn test --runInBand, yarn build and the production Docker build. Run ESLint/Prettier for the changed paths and required repository checks. Verify existing partial-transcription/notes tests still pass. No production meeting or content retrieval is part of validation.
- [ ] Review the integrated branch for lifetime/resource leaks, unhandled promises, repeated warnings, callback ownership and protocol misclassification. Verify the voice patch and existing probe were not accidentally replaced.
- [ ] Preserve separate process and DAVE commits. If the optional gate failed, rewrite the PR title/body and scope around the process fix alone and clearly report the DAVE deferral.
- [ ] For an authorized PR handoff, push the exact head and satisfy the 30-minute commit window. Refresh required/informational checks, comments, formal reviews, inline threads and mutable sticky summaries afterward. Address valid feedback and refresh again before declaring merge-ready.
- [ ] Deployment needs its own authorization. After a verified rollout, extend the existing daily monitor to aggregate Voice subscription replacement failed:, Voice state operation failed:, Voice error notification failed: and, if shipped, DAVE pending input skipped:. Keep exact bounded filters, the metadata whitelist and opusPacketBytes=UNKNOWN. Do not mistake warning suppression or intentional skips for restored capture.

## Evidence appendix

### Task 1 file map

- Create src/utils/disposeVoiceStream.ts and test/utils/disposeVoiceStream.test.ts.
- Modify src/audio.ts and test/audio/voiceSubscriptions.test.ts.
- Create test/audio/fixtures/voiceCaptureExit.cjs and test/audio/processExit.test.ts.
- Add the minimal close-listener identity guard to patches/@discordjs+voice+0.19.2.patch in both CJS and ESM, with test/audio/voiceReceiverOwnership.test.js using the real receiver.

### Task 2 file map

- Modify src/audio.ts, src/bot.ts and src/meetings.ts.
- Extend test/audio/voiceSubscriptions.test.ts, test/audio/processExit.test.ts and test/audio/fixtures/voiceCaptureExit.cjs.
- Create test/bot.voiceFailureBoundaries.test.ts and test/meetings.voiceFailureBoundaries.test.ts.

### Task 3 file map

- Create test/audio/daveActivation.test.js and the synthetic-only harness under test/audio/fixtures/daveActivation/.
- Create test/audio/fixtures/runDAVEActivationGate.cjs for production-codec verification.
- A development-only generator or validation image, if necessary, belongs under test/audio/fixtures/daveActivation/. Exclude its sources/build outputs from the production image. No production native API or dependency change is in scope.
- If that generator is needed, modify .dockerignore narrowly to exclude its source/build directory, and use a separate test/audio/fixtures/daveActivation/Dockerfile.validation or an explicit read-only mount for validation. Keep the production image free of generator tooling.

### Task 4 file map

- Create src/utils/daveProtocolFrame.ts and test/utils/daveProtocolFrame.test.ts.
- Modify src/utils/opusDiagnosticDecoder.ts and src/audio.ts.
- Extend test/audio/voiceSubscriptions.test.ts, test/audio/receiveDiagnostics.test.js and test/audio/daveActivation.test.js.
- Complete test/audio/fixtures/runDAVEActivationGate.cjs.

### Source and verification references

Planning source baseline: remote master at 3e3981968955a82e06f2d4544b3c3dec6a8b76a2. Investigation source: 2578502c57b34c58f8dd1f112e44a0ac858b763d. Pinned parser reference: Davey 0.1.12 at a1e2e741bea06bc3b7167a5c3792844b8975993c. Existing voice patch: patches/@discordjs+voice+0.19.2.patch.

The private investigation report retained in the ops repository records eight exit controls and twenty native activation scenarios. They used Windows Node 24.18/OpusScript and do not satisfy the new Linux/native-codec DAVE gate. Actual production exit cause, authenticated failing inputs and resume exposure remain UNKNOWN.

The builder check found no important unanswered design questions. This plan was self-reviewed for spec coverage, consistent interfaces, failure cases and proportionality, then edited with unslop. The approved planning copies are carried into the isolated execution worktree and committed in sanitized form.
