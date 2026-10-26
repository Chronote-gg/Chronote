# Keep voice capture failures from terminating the bot

## Recommendation and decision

Ship one PR that contains recoverable voice subscription failures and makes stream teardown safe. Include a small DAVE guard before Opus decoding if the native activation and frame-classification tests pass. Keep these changes in separate commits so the DAVE portion can be removed without delaying crash prevention.

For someone recording a meeting, a failed participant stream should leave the bot running, preserve the other streams, and produce notes from usable speech with the existing incompleteness notice. A pending DAVE frame should never become unauthenticated Opus input merely because native activation has not finished.

Approved for subagent implementation on October 14, 2026, including the DAVE guard in the same PR only if its stated tests pass. Production exit cause remains UNKNOWN. These are reproduced local defects, not a claim that either caused a particular production exit.

## Proposed scope

| Included                                                             | Deferred                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pending stream errors during cleanup                                 | Process-wide exception suppression or keeping a corrupted process alive                            |
| Rejected timer resubscription and partial construction cleanup       | New retry budgets, backoff, or reconnect policies                                                  |
| Voice-state callback and voice-error notification rejection handling | Startup/login promise cleanup, which has a different failure policy                                |
| Conditional pending-DAVE input guard in the application decoder      | MLS negotiation changes, suppressed-reply retry, dependency upgrades                               |
| Regression tests and content-free failure/drop markers               | Fatal-log investigation, new fatal instrumentation, capture reconstruction and history/UI recovery |

The existing recovery chat retains capture reconstruction and history/UI ownership. Execution must rebase on current remote source and check for overlap before editing shared voice files. This plan does not send that chat a new assignment.

## Process-exit behavior

### Safe teardown

Before disposing a subscription, suppress its recovery callbacks and cancel its timer. Detach the owned data/end/recovery handlers, unpipe the old pipeline, and destroy each distinct stream once. The decoder and decodedStream are currently the same object and must be deduplicated.

Keep an error consumer attached throughout destruction, including an error already queued by destroy(error). Remove the teardown guard after close. If a stream does not emit close, the guard may remain on that unreachable stream until garbage collection. It must not keep the stream in a strong global registry. Never use removeAllListeners to remove other owners' handlers.

Late events must neither schedule another subscription nor write PCM into a replacement capture. Repeated cleanup is harmless. Receiver-map deletion must affect only the stream being disposed, never a newer stream for the same participant. The pinned library currently removes entries by key alone on close. Add the minimal identity guard to that listener in both runtime distributions so its retained callback cannot delete a replacement.

### Contain recoverable async failures

subscribeToUserVoice keeps rejecting to awaited callers, but cleans up any source/decoder it created before a construction or pipe failure. While capture is active, that failure marks captureIncomplete.

The existing 250 ms resubscription callback must consume that rejection. Recheck meeting finishing, connection destruction, participant membership and subscription ownership when the timer fires. A failed replacement produces one sanitized failure marker and releases partial resources. It does not create a new automatic retry loop. Other participants continue; the affected participant can be retried by a later normal join/reconnection path. This keeps the patch small, but a persistent subscription failure can leave that participant uncaptured until such a path runs.

The registered voice-state callback consumes its own rejection. Subscription failures mark the affected capture incomplete at the subscription boundary. The wrapper records only a fixed operation/stage enum and meeting correlation where already available; it does not dump VoiceState, identities or the exception message.

A rejected voice-error notification is handled as a failed notification. It does not terminate capture or recursively attempt another notification. Fatal startup failures retain their current termination policy. Awaiting login/setupBot and changing all-mode startup ordering are separate work.

## Conditional DAVE guard

### Where it belongs

Use the existing immutable per-input receiver snapshot at OpusDiagnosticDecoder._transform. This is the input actually being decoded, including queued writes. Do not inspect the connection's latest state or the last received packet.

Skip input only when all of these are true:

1. The input has attributed receiver diagnostics.
2. daveProtocolVersion is 1, daveReady is false, and daveDecryptDecision is not-ready.
3. The complete protocol frame structure passes validation.

The guard completes that transform without PCM or error and leaves the subscription open. Successful native activation continues normally through the existing voice library. The next usable input can decode without recreating the receiver or resetting MLS.

The complete check covers supplemental bounds, marker position, a valid bounded ULEB128 nonce, complete offset/length pairs, ordering, non-overlap and ranges within the media portion. A footer candidate alone is insufficient. Ordinary plaintext, the silence exception, protocol zero, already-decrypted inputs and unattributed inputs retain their existing behavior. A structural match is not authentication or proof of production ciphertext.

This recommendation follows the [DAVE protocol frame check](https://daveprotocol.com/#protocol-frame-check). A genuine plaintext frame can rarely match protocol structure. That creates a false-positive discard risk. Tests must document it rather than promise that every possible plaintext frame is distinguishable.

### Preserve incomplete-capture reporting

Each deliberate skip during active capture marks captureIncomplete. Emit at most one new content-free marker per decoder instance: DAVE pending input skipped:. Keep the mark for subsequent skips without producing per-packet logs. Include meeting correlation and the existing scalar readiness/reset/reply fields only. Do not include participant IDs, payloads, packet sizes, PCM, arbitrary exceptions or new transition identifiers.

A drop callback failure must become a contained stream error through the transform callback, not an uncaught throw. Teardown suppresses stale callbacks. Existing decoder failures retain their current failed-input correlation and recovery behavior.

This policy discards currently undecodable protocol frames rather than buffering media or forcing native decrypt while decryptors are missing. It avoids resource growth and preserves legitimate plaintext. It cannot reconstruct the skipped audio or complete a stalled MLS handshake.

### Gate for including DAVE in this PR

Before the guard is accepted, create two matching synthetic native MLS members, process a valid welcome and commit without stubbing native MLS methods, and prove authenticated remote decryption. Repeat after native reset and with delayed activation. Keys and media must be generated for the local test only and never printed.

Check positive and negative frame vectors against a pinned independent native parser oracle. Document any disagreement between the native parser and the whitepaper, including supplemental bounds and range bounds. Do not ship until the classifier's intended rules are explicit and the relevant vectors agree. A candidate footer or a wrong-sender authentication failure cannot substitute for this proof.

Exercise the application decoder with Linux Node 24.15.0 and @discordjs/opus, as well as real CJS/ESM receiver controls. Confirm that pending protocol frames do not enter the codec, legitimate plaintext and silence still work, and correctly decrypted frames decode after activation on the same stream. Deterministic expectations must not depend on random ciphertext causing an Opus error.

If this needs a new production native API, vendored Rust runtime, a dependency upgrade, or cannot establish authenticated two-member controls and parser agreement, remove the DAVE behavior change from this PR. Keep the demonstrated process-exit fix moving and report the failed gate. A development-only fixture generator is acceptable if it generates synthetic states reproducibly and does not enter the production image.

## Verification and release

Use real Node streams and subprocesses for the exit regressions. The former fatal controls must remain alive and still demonstrate expected recovery or a contained failure. Successful startup failures remain fatal in comparison controls. Test queued errors, alias streams, repeated cleanup, stale timers, departures, finishing meetings, receiver/decoder construction failures and notification rejection.

Run focused Jest suites, the backend build, changed-file lint/format checks, relevant full backend tests and the production Docker build. A Windows/OpusScript result alone does not satisfy the DAVE gate. Neither local tests nor healthy service startup proves the production exit cause or resume exposure.

PR readiness follows the current exact-head checks, comments, reviews, threads and mutable summaries after the 30-minute window. Merge and deployment remain separate actions. After a separately authorized and verified release, teach the existing daily monitor the new skip/failure markers and establish the exact rollout boundary. Zero decoder warnings alongside new skips must not be reported as restored audio. The current monitor remains unchanged during planning.

## Engineering reference and evidence

Expected production changes: src/audio.ts, src/bot.ts, src/meetings.ts and a small stream-disposal helper. Conditional DAVE changes: src/utils/opusDiagnosticDecoder.ts and a pure protocol-frame classifier. Tests belong beside the existing audio suites; use subprocess cases for process survival. No public decoder API or production dependency change is proposed. The only voice patch addition is the receiver-close identity guard required for safe teardown; it does not change MLS or decrypt behavior.

The plan uses existing TypeScript, Node streams, Jest and the pinned voice/Davey integrations. Existing processing must keep generating notes from usable partial transcripts with its current notice. Do not reset captureIncomplete after recovery.

- Source baseline refreshed from remote master during planning: 3e3981968955a82e06f2d4544b3c3dec6a8b76a2. The relevant resubscription, teardown, notification and decoder boundaries remain present.
- Independently investigated deployed source: 2578502c57b34c58f8dd1f112e44a0ac858b763d.
- Native parser reference: Davey 0.1.12 at a1e2e741bea06bc3b7167a5c3792844b8975993c.
- Detailed process-exit operational evidence remains in the private ops repository.
- Detailed activation operational evidence remains in the private ops repository.

The planning copies were written before implementation. Execution uses an isolated topic worktree and commits these sanitized design documents with the change. No product code was changed during planning.
