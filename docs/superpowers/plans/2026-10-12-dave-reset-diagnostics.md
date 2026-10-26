# DAVE reset diagnostics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Explain the latest native DAVE reset and recovery reply disposition on the exact input that fails Opus decoding.

**Architecture:** Keep one bounded reset episode on each DAVE wrapper. Pass its reference to the existing reply handlers, then copy its scalar fields into the current immutable receiver snapshot. Format four additional fields through the existing decoder-error formatter, preserving all audio and recovery behavior.

**Tech stack:** TypeScript, patched @discordjs/voice 0.19.2 CJS/ESM, native Davey 0.1.12, Jest, patch-package.

**Spec:** [Approved design](../specs/2026-10-11-dave-reset-diagnostics-design.md).

## Global constraints

- Exactly four added warning fields: `daveResetReason`, `daveResetAgoMs`, `daveKeyPackageDisposition`, `daveInvalidationDisposition`.
- Reasons: `none`, `initial`, `epoch-1`, `invalid-welcome`, `invalid-commit`, `decrypt-failures`, `unknown`. Missing instrumentation formats as `UNKNOWN`.
- Dispositions: `not-emitted`, `send-returned`, `skipped-resuming`, `skipped-other-state`, `send-threw`. Missing instrumentation formats as `UNKNOWN`.
- Age is nonnegative milliseconds at receiver input; no attempt is `none`, missing evidence is `UNKNOWN`.
- Preserve decryption/passthrough/drop, native calls, failure thresholds, state gates, reply order, original exceptions, capture-incomplete and resubscription behavior.
- One latest episode only; no counters, event history, new log markers, successful-input logs, broad voice debug, analytics, dependencies or production access.
- Never add packet contents, user content, identities, key packages, transition IDs or exception text to diagnostic state or added fields. Production packet size access remains forbidden.
- Start from `origin/master` at `c46df7a8d5aacadc65a4b413e56fd259c2f0105d` on `codex/voice-reset-diagnostics` in the existing isolated worktree. The monitor remains paused; no release is authorized by this plan.

## Review focus

- Recovery emits invalidation before reinit: both reply dispositions must survive in the same episode.
- Initial creation emits before installation in networking state: attribute the reply to the emitting wrapper.
- Guard-suppressed recovery, ignored epochs and protocol-zero/no-native reinit must not invent a new attempt.
- The send wrapper may emit an error then return normally: `send-returned` is not delivery proof; actual throws must propagate unchanged.
- An older queued decoder input must keep its original age/reason/dispositions after later reset or reply mutation.

## Task 1: Add the complete bounded reset diagnostic

**Files:**

- Modify `patches/@discordjs+voice+0.19.2.patch`: CJS, ESM, both receiver declaration files.
- Modify `src/utils/opusDiagnosticDecoder.ts`: existing failure formatter only.
- Create `test/audio/daveResetDiagnostics.test.js`: reset lifecycle, send gate and native controls.
- Modify `test/audio/receiveDiagnostics.test.js` and, if required, `test/audio/daveResume.test.js`: exact snapshot expectations, queued-input and CJS/ESM parity controls.
- If native activation needs fixture data, add only the minimal upstream public MLS controls to `test/audio/fixtures/davePublicControls.cjs`, with pinned-source provenance. Tests must not depend on ignored investigation files or network access.

**Interfaces:**

- Wrapper owns `resetDiagnostics`: `{ reason, atMs, keyPackageDisposition, invalidationDisposition }`, initially `none`, `null`, `not-emitted`, `not-emitted`.
- Internal `recordReset(reason)` creates/assigns a fresh episode with `Date.now()` and returns it. Internal `reinit(reason = "unknown", episode?)` starts a new episode only for native work, or retains the supplied recovery episode.
- `recoverFromInvalidTransition(transitionId, reason = "unknown")` passes the existing guard, creates one episode before invalidation, emits the existing first argument plus the episode reference, and calls reinit with the same episode. Preserve existing mutation/emission order.
- Initial creation calls reinit with `initial`; accepted epoch 1 uses `epoch-1`; invalid welcome/commit and threshold recovery pass their respective reasons.
- Key-package and invalidation events gain an optional second episode argument. Existing networking handlers record the disposition on that supplied episode and preserve their original gate/send/exception behavior. Direct legacy handler calls without an episode still work.
- Receiver snapshot fields use the specified reason/disposition unions or `null` for missing instrumentation; age is `number | null`. The formatter uses reason presence to distinguish no-attempt age `none` from missing age `UNKNOWN`. Both declaration files match.

- [x] Write focused failing tests before modifying the patch/helper. Record command and expected failure in the implementation report.

Pin these assertions through actual wrapper/state-machine methods, with native methods only stubbed where fault injection requires it:

```js
expect(snapshot).toMatchObject({
  daveResetReason: "decrypt-failures",
  daveKeyPackageDisposition: "skipped-resuming",
  daveInvalidationDisposition: "skipped-resuming",
});
expect(Object.isFrozen(snapshot)).toBe(true);
```

Cover classified initial/epoch/welcome/commit/decrypt recovery and direct unknown reinit; guard-suppressed duplicate recovery; ignored epoch; protocol-zero/no-native no-op; new wrapper reset of history; successful native activation retaining latest evidence. Check exact invalidation-before-key-package order and both dispositions in one episode. Check initial attribution before wrapper installation. Exercise SelectingProtocol, Ready, Resuming and rejected/closed send gates, including both original thrown-send errors and an error-emitting wrapper that returns normally.

Use the native investigation at `tmp/voice-seam/dave-native-lifecycle-repro.cjs` only as a development reference. Promote a minimal offline native MLS activation/reset/recovery control into the tracked tests; preserve valid plaintext and exceptional-silence behavior. Verify that Resumed does not retry replies or clear the pending episode, because this is instrumentation only.

- [x] Run the new focused test and confirm a meaningful red failure, not setup/import failure.

Command: `node node_modules/jest/bin/jest.js --runInBand --coverage=false --runTestsByPath test/audio/daveResetDiagnostics.test.js test/audio/receiveDiagnostics.test.js test/audio/daveResume.test.js`.

- [x] Implement the smallest diagnostic plumbing in installed voice files, regenerate the existing patch with patch-package, and update the failure formatter. Keep CJS/ESM equivalent and preserve original first event arguments. Set `send-threw` before calling the existing send and `send-returned` afterward without intercepting its exception.

- [x] Add/extend queued-transform, missing-instrumentation and CJS/ESM tests. Take an immutable snapshot, mutate/replace the episode before its queued decoder failure, and assert the formatter retains the original scalars and receive-time age. Assert known-no-attempt age `none`, missing values `UNKNOWN`, nonnegative age under clock rollback, and only the allowed scalar keys in episode/snapshot.

- [x] Run focused audio tests to green. Verify the patch applies to a pristine copy of the pinned voice package and preserves the existing resume guard/per-input diagnostic. Do not add a dependency or rely on an already patched node_modules tree as the only acceptance evidence.

- [x] Run backend build/type check, changed-file lint/format and the full unit suite once. Record exact output and separate any pre-existing failure from this change. Commands: `node node_modules/typescript/bin/tsc`; `node node_modules/jest/bin/jest.js --runInBand --coverage=false`; ESLint and Prettier on the changed TS/JS/docs files.

- [x] Commit only task files and approved spec/plan, then self-review the diff against every spec requirement. Return a report with red/green evidence, clean-patch proof, validation, commits and concerns. Do not push, publish, deploy or change the paused monitor.

## Completion checks

- [ ] Fresh task review checks spec compliance and code quality against the committed diff.
- [ ] Fresh whole-branch review checks patch distribution/parity, lifecycle attribution, diagnostic privacy and unchanged behavior. Address valid findings and run their covering checks.
- [x] Preserve local committed work for review. Publishing/releasing this diagnostic and scheduling observation of a verified rollout remain outside this implementation approval.
