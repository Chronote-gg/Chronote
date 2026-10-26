# Transcription tracing overlap implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Status:** Implemented and validated before retry integration.

**Goal:** Start ASR while independent tracing audio preparation runs.

**Architecture:** Keep both operations in the existing generation scope and
drain the complete owned attachment promise in finally before returning.

**Tech Stack:** Node.js 24.15.0, TypeScript, Jest, Bottleneck, Langfuse 5.13.1.

**Spec:** [Transcription cost and latency design](../specs/2026-10-21-transcription-cost-latency-design.md).

## Global constraints

- Preserve audio, rendered prompts, effective models, model parameters, guards, voting and cleanup retention rules.
- Preserve saved recording v1 settings, durable checkpoints, notes generation and delivery ordering.
- Keep ASR concurrency 2, queue capacity 100 and logical-start spacing 800 ms; keep attachment concurrency 1 and spacing 0 ms.
- Use existing Langfuse observations for numeric diagnostics; add no content, identifiers or PostHog properties.
- Add no dependencies, rollout toggles, schema migrations or quality exceptions.

## Review focus

- Attachment encoding outlives a successful ASR response.
- Abort arrives after ASR success but before attachment settlement.
- Provider failure coincides with attachment/update/logger failure.
- Attachment input and ASR usage updates complete in either order.
- Queued attachment cancellation must skip encoding and still settle ownership.

## Files and responsibilities

- Modify `src/services/transcriptionService.ts`: overlap/drain ordering only.
- Create `test/services/transcriptionTracing.test.ts`: deferred tracing
  integration contracts.
- Reuse `test/observability/langfuseAudioAttachment.test.ts`,
  `test/services/transcriptionSnippetResult.test.ts` and
  `test/services/meetingProcessingLifetime.test.ts` as regressions.
- No changes to attachment helper, limiter constants or public interfaces.

## Task 1: overlap work inside the existing owned generation

**Interfaces:**

- Consumes unchanged `TranscriptionContentInput.signal` and
  `effect<T>(run: () => Promise<T>): Promise<T>`.
- Consumes existing `buildLangfuseTranscriptionAudioAttachment(file)`.
- Produces no new public function. The complete best-effort attachment chain
  remains a handled `Promise<void>`; successful transcription returns only
  after its drain and a final signal fence.

- [x] **Step 1: write failing overlap and lifetime tests.**

Build a tracing-enabled fixture with deferred attachment/provider promises,
an execution-entered barrier, fake ffmpeg/fs and observation-scope end spy.
Exercise real snippet orchestration. Do not reuse the existing tracing-off
fixture unchanged. Use promise barriers rather than wall-clock sleeps.

```ts
test("dispatches ASR before attachment preparation finishes", async () => {
  const f = await buildTracingFixture();
  const result = f.transcribe();
  await f.attachmentEntered;
  await f.providerEntered;
  expect(f.attachmentSettled()).toBe(false);
  f.provider.resolve(f.validResponse);
  await f.providerSettled;
  expect(f.generationEnded).not.toHaveBeenCalled();
  expect(f.wavDeleted).not.toHaveBeenCalled();
  f.attachment.resolve(f.validAttachment);
  await expect(result).resolves.toMatchObject({ status: "succeeded" });
  expect(f.generationEnded).toHaveBeenCalledTimes(1);
  expect(f.wavDeleted).toHaveBeenCalled();
});
```

The public snippet result uses status succeeded or failed.
Add both completion orders and assert prompt/model input, audio metadata,
known usage, selected candidate and output survive.

For late abort, settle ASR, abort while attachment is held, then release
attachment. Assert a failed terminal snippet and no successful publication.
For queued abort, hold the attachment limiter, abort, release the queue and
assert the helper never starts. For started attachment abort, assert real
settlement precedes WAV deletion and no aborted attachment trace update runs.

Capture the private provider rejection at the existing policy execution
boundary. Combine the same provider error with attachment rejection,
observation-update throw and attachment-warning throw. Assert identical
provider error identity and no unhandled rejection.

- [x] **Step 2: demonstrate the serial-order regression.**

Run `yarn test --runInBand test/services/transcriptionTracing.test.ts`.
Expected RED: the provider-entered barrier is not reached while attachment
preparation is blocked. Use a bounded test harness timeout only to report
the missing event; do not add implementation delays.

- [x] **Step 3: change dispatch and settlement ordering.**

Start the existing complete owned attachment chain, immediately attach its
terminal nonthrowing catch, and save the promise. Run ASR/selection/accounting
inside try. Await attachment in finally inside startActiveObservation.
After successful finally, fence cancellation and return selected text.

Preserve existing attachment catches and metadata fields. Do not return a
successful value from inside try, detach work, or use Promise.all to release
the generation after the first rejection. Keep the current queued-start
signal fence and running ffmpeg drainage.

- [x] **Step 4: verify lifetime, metadata and feature regressions.**

Run:

```bash
yarn test --runInBand test/services/transcriptionTracing.test.ts test/observability/langfuseAudioAttachment.test.ts test/services/transcriptionSnippetResult.test.ts test/services/meetingProcessingLifetime.test.ts test/commands/endMeetingNotesLatency.test.ts
yarn build
yarn lint:check
yarn prettier:check
yarn check:quality
```

Expected GREEN. Verify the active observation has ended only after all
updates and owned effects settle, and temporary MP3/WAV cleanup remains
correct on each failure/abort path. This proves overlap and lifecycle
behavior, not a production latency percentage.

- [x] **Step 5: commit the independently working change.**

Commit `[AGENT] perf: overlap transcription tracing preparation with ASR`.
Request review of late cancellation and error precedence. Preserve this
suite as a required regression when executing the retry plan next.

## Validation evidence recorded on 2026-10-21

Tracing overlap is implemented. The integrated pre-retry baseline
`5e9ceec5f56e1a22215ea8ba9b57f6e7849c0acc` passed 395 suites and 3,866
tests, 136 visual tests and strict quality. Tracing additionally passed
39 focused tests and independent review. These results describe the
pre-retry baseline; subsequent integration checks and review are tracked
in the PR.

See [PR #430 checks](https://github.com/Chronote-gg/Chronote/pull/430/checks).
Production cost, latency and quality effects remain unmeasured.
