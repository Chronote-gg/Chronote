# Voice decoder diagnostic probe implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify whether recurring Opus decoder failures involve DAVE-encrypted frames reaching the decoder, without changing recording or recovery behavior.

**Architecture:** Keep the existing per-speaker resubscribe path. For capture meetings, remember the time of the public voice-connection `transitioned` event. At each decoder failure, add only the last received Opus packet's length, a DAVE-footer candidate flag, and the age of the last transition to the existing warning.

**Tech Stack:** Node.js 24.15.0, TypeScript, `@discordjs/voice` 0.19.2, `prism-media` 1.3.5, Jest, CloudWatch Logs.

**Spec:** [Voice receiver resubscribe ADR](../../adr-20260106-voice-receiver-resubscribe.md), especially its recovery decision and follow-up note. This plan defines the narrow diagnostic follow-up.

## Global Constraints

- No capture, transcription, note-generation, or resubscribe behavior change. The partial-notes notice remains `Some audio could not be transcribed. These notes may be incomplete.`
- No packet bytes, audio, transcripts, notes, new identifiers, or raw voice debug output in logs or telemetry. Log only derived numeric/boolean shape metadata on an existing decoder failure.
- No new dependency, configuration, persistent database field, analytics event, or broad voice debug mode.
- The DAVE-footer flag means _candidate_, not confirmed encrypted media. A missing marker does not rule out DAVE, and transition age reports executed transitions only.
- Execution starts from freshly fetched `origin/master` on a new branch in an isolated worktree. The plan was prepared from `1208dad32e5d33e75dd118cb052d3e246c0a5997`, behind the deployed merge. Keep `.cache/` investigation files out of commits.

## Review Focus

- Decoder failure before any packet: log `none` for packet metadata and still mark capture incomplete and resubscribe.
- Packet with a plausible DAVE footer: log the candidate flag and byte count, never packet content.
- Short packet or `0xFAFA` with an impossible footer size: log `false` without throwing or changing recovery.
- Recent transition and no observed transition: log a nonnegative age or `none`, respectively.
- TTS-only sessions and finishing meetings: do not add capture diagnostics to TTS-only sessions or revive a finishing subscription.

---

### Task 1: Add failure-only packet-shape diagnostics

**Files:**

- Modify `src/types/audio.ts` (`AudioData`).
- Modify `src/meetings.ts` (`initializeMeeting`).
- Modify `src/audio.ts` (`VoiceSubscriptionState` and `subscribeToUserVoice`).
- Test `test/audio/voiceSubscriptions.test.ts` and `src/__tests__/meetings.test.ts`.

**Interfaces:** `AudioData.lastDaveTransitionAtMs?: number` is written by `initializeMeeting` and read by `subscribeToUserVoice`. The subscription retains only `lastOpusPacketBytes?: number` and `lastOpusPacketDaveFooterCandidate?: boolean`. The existing warning gains `opusPacketBytes`, `daveFooterCandidate`, and `daveTransitionAgoMs`, with `none` for unavailable values.

- [ ] **Step 1: Add failing tests.** Extend the existing fake decoder so a test can emit its `error` event. Feed marked, unmarked, too-short, and impossible-size packets through the received stream; assert the three warning fields, absence of packet contents, `captureIncomplete`, and one scheduled resubscribe. Exercise an error before a packet and after an observed transition. In the existing meeting tests, invoke the captured `transitioned` listener and assert its timestamp is saved for a capture meeting, while a TTS-only meeting installs no such listener. Retain the finishing-meeting assertion.
- [ ] **Step 2: Confirm the tests fail for the missing diagnostics.** Run `yarn jest --runInBand --runTestsByPath test/audio/voiceSubscriptions.test.ts src/__tests__/meetings.test.ts --coverage=false --silent`; expect assertion failures on the new fields/listener.
- [ ] **Step 3: Implement the minimum instrumentation.** Register `connection.on("transitioned", ...)` after constructing a capture meeting and before awaiting participant setup. In `subscribeToUserVoice`, observe each Opus `Buffer` before piping and retain only its length and a footer candidate boolean: at least 13 bytes, trailing `0xFAFA`, and the preceding supplemental-size byte from 12 through `packet.length - 1`, following the [DAVE payload format](https://github.com/discord/dave-protocol/blob/main/protocol.md#payload-format). Add those values and `Math.max(0, Date.now() - lastDaveTransitionAtMs)` when present to the existing decoder warning. Do not change other error handlers or the resubscribe call.
- [ ] **Step 4: Verify behavior.** Re-run the focused Jest command; expect all tests to pass. Run `yarn build`, `yarn lint:check`, and `yarn prettier:check`. Review the diff for accidental packet retention, content logging, capture behavior changes, and `.cache/` staging.
- [ ] **Step 5: Commit the five named source/test files and this plan** on a branch based on current `master`. Stage named paths only, never `.cache/`.

## Release and readout

- [ ] Open a narrow PR describing the current symptom, the metadata-only probe, and why a candidate footer is evidence rather than proof. Require current-head CI and the repository's post-commit 30-minute feedback refresh before calling it merge-ready.
- [ ] After separate merge authorization, let the `master` deploy run. It waits for active-meeting leases before replacing the ECS task. Verify the deployed image, ECS health, and the first capture-meeting logs.
- [ ] Review CloudWatch after three distinct meeting-level decoder incidents or 14 days, whichever comes first. Count paired decoder/decoded-stream warnings once per incident; compare `captureIncomplete`, completed notes, and decoder frequency with the pre-probe period. Report only aggregate findings.
- [ ] If a candidate footer appears, investigate DAVE decrypt/readiness at the receiver seam before proposing a fix. If markers are absent or the sample is empty, report the result as inconclusive; consider a separate, scoped RTP-layer probe only if failures continue. Remove or renew this probe after the readout rather than leaving it unreviewed indefinitely.
- [ ] If capture or logging regresses, restore the previous known-good backend task definition after checking active-meeting leases, then verify ECS stability and meeting delivery.
