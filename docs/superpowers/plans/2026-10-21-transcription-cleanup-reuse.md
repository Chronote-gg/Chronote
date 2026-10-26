# Transcription cleanup reuse implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Status:** Implemented and validated before retry integration.

**Goal:** Avoid duplicate successful cleanup requests during one finalization.

**Architecture:** A compiler closure holds one accepted prepared-request result.
Compilation and cleanup own separate modules; standalone and recovery paths
retain independent lifetimes.

**Tech Stack:** Node.js 24.15.0, TypeScript, Jest, existing OpenAI/Langfuse integration.

**Spec:** [Transcription cost and latency design](../specs/2026-10-21-transcription-cost-latency-design.md).

## Global constraints

- Preserve audio, rendered prompts, effective models, model parameters, guards, voting and cleanup retention rules.
- Preserve saved recording v1 settings, durable checkpoints, notes generation and delivery ordering.
- Keep reusable cleanup results inside one normal finalization; never persist them or share them across meetings.
- Use existing Langfuse observations for numeric diagnostics; add no content, identifiers or PostHog properties.
- Add no dependencies, rollout toggles, schema migrations or quality exceptions.

## Review focus

- A file arriving while cleanup waits remains supplemental, outside the captured transcript.
- Changed prompt context invalidates reuse even when transcript text is unchanged.
- A failed or rejected first cleanup leaves the upload compilation its retry opportunity.
- Reusing the same MeetingData in another finalization never shares the prior result.
- Cancellation before reuse/admission prevents successful publication.

## Files and responsibilities

- Create `src/services/transcriptionCleanupService.ts`: prepared cleanup,
  frozen execution and retention, extracted from transcriptionService.
- Create `src/services/transcriptCompilationService.ts`: formatting,
  synchronous scope capture, standalone compilation and reusable compiler.
- Modify `src/audio.ts`: remove moved compile implementation and imports.
- Modify `src/services/transcriptionService.ts`: remove moved cleanup APIs.
- Modify `src/commands/endMeeting.ts`: own one compiler in normal finalization.
- Modify `src/services/recoveryTranscriptionProcessing.ts`: direct cleanup import.
- Create `test/services/transcriptCompilationService.test.ts`.
- Create `test/services/transcriptionCleanupService.test.ts`.
- Modify `test/services/transcriptionService.test.ts`: retain coalescing tests.
- Modify `test/services/recordingContentService.test.ts`,
  `test/commands/endMeeting.test.ts`,
  `test/commands/endMeetingNotesLatency.test.ts`,
  `test/fixtures/endMeeting.ts` and
  `test/audio/startProcessingSnippet.test.ts`: move mocks/imports.

## Task 1: own and reuse accepted cleanup

**Interfaces:**

- Produces `CompileTranscriptionsOptions`, `MeetingTranscriptCompiler`,
  `createMeetingTranscriptCompiler(client, meeting)` and standalone
  `compileTranscriptions(client, meeting, options?)` exactly as in the spec.
- Produces `prepareTranscriptionCleanup(meeting: MeetingData,
transcription: string): Promise<PreparedTranscriptionCleanup>`.
- `PreparedTranscriptionCleanup` contains `transcription: string`,
  `prompt` using the existing messages/langfusePrompt Pick type, and
  `model: SavedRecordingSettings["models"]["transcriptionCleanup"]`.
- Preserves the current typed `cleanupContentTranscription` and
  `retainCleanupTranscript` signatures in their new module.
- Consumes existing capture, prompt builders, parameter resolution and chat
  execution. Recovery uses saved-input execution without live preparation.

- [x] **Step 1: write failing compiler contracts.**

Build a local fixture in the new compiler test using real compilation with
prompt/provider boundaries mocked. Expose client, meeting, cleanup mock and
returned acknowledgement history. Pin the principal assertions:

```ts
test.each([undefined, [], [{ text: "" }]])(
  "reuses accepted equivalent cleanup with cues %j",
  async (cues) => {
    const f = buildCompilerFixture({ cues });
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    const notes = await compile({ cleanupAcknowledged: f.ack });
    const upload = await compile({ includeCues: true });
    expect(upload).toBe(notes);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.ack).toHaveBeenLastCalledWith("acknowledged");
  },
);
```

Add parameterized key-miss tests for transcript, nonempty/whitespace cues,
speaker, timestamp, rendered messages, prompt version/fallback, model, params
and retention ratio. Assert chronological cues and unchanged headers.
Assert copied equivalent parameter objects with reversed key insertion order
hit. A successful unchanged cleanup must hit too.

Add separate failure contracts:

```ts
expect(firstOutput).toBe(originalWithHeader);
expect(firstAcknowledgement).toBe("fallback");
expect(secondOutput).toBe(acceptedWithHeader);
expect(cleanup).toHaveBeenCalledTimes(2);
```

Exercise provider rejection and retention rejection separately. Assert zero
calls for empty/disabled input; separate compiler closures and standalone
calls execute separately. Abort before a hit, during preparation and after
provider settlement must prevent reuse/admission.

- [x] **Step 2: run the focused tests and record the expected failure.**

Run `yarn test --runInBand test/services/transcriptCompilationService.test.ts`.
Expected RED: missing new module/factory or two provider calls instead of one.
Do not weaken existing checkpoint or failure assertions.

- [x] **Step 3: extract modules, then implement the compiler contract.**

Move existing code and headers verbatim before adding reuse. Use one private
compilation implementation behind the standalone and closure APIs. Capture
selected files before the first await. Prepare current prompt/model values,
compare copied value snapshots via `isDeepStrictEqual`, and cache only
settled retention-accepted output. Preserve all acknowledgement outcomes,
signals, fallback logging and header formatting.

Remove old exports and the unused live cleanup wrapper. Migrate every caller
and mock listed above in the same commit. Instantiate one normal-finalization
compiler and use it for both existing stages. Keep cancellation standalone.

Move cleanup unit contracts into the cleanup-module test. In the held-cleanup
recording-content test, wait for an explicit execution-entered barrier,
append a file, then release cleanup. Assert the late file is absent from
final text and checkpoint `supplementalEntries` is true.

Add end-meeting assertions for one factory invocation, two calls to its
returned compiler, first-call acknowledgement callback, second-call
`includeCues: true`, final transcript/checkpoint and upload contents.
Keep best-effort reuse metadata failure from affecting compilation.

- [x] **Step 4: verify feature and regression contracts.**

Run:

```bash
yarn test --runInBand test/services/transcriptCompilationService.test.ts test/services/transcriptionCleanupService.test.ts test/services/transcriptionService.test.ts test/services/recordingContentService.test.ts test/commands/endMeeting.test.ts test/commands/endMeetingNotesLatency.test.ts test/services/recoveryTranscriptionProcessing.test.ts test/services/notesService.test.ts test/services/meetingProcessingLifetime.test.ts test/audio/startProcessingSnippet.test.ts
yarn build
yarn lint:check
yarn prettier:check
yarn markdownlint:check
yarn check:quality
```

Expected GREEN. Search imports and mocks with `rg -n
'compileTranscriptions|cleanupTranscription|cleanupContentTranscription|retainCleanupTranscript'
src test`. No moved API may remain exported/imported through its old module.
Review audio.ts and transcriptionService.ts line counts against the PR base;
both should shrink. Inspect changed documentation for accuracy.

- [x] **Step 5: commit the independently working change.**

Stage only the files in this plan and any necessary architecture-reference
updates. Commit with `[AGENT] perf: reuse accepted identical transcription cleanup`.
Request review of key identity, fallback retry and checkpoint capture before
the next plan. Preserve recording v1 and notes mention regression results.

## Validation evidence recorded on 2026-10-21

Cleanup reuse is implemented. The integrated pre-retry baseline
`5e9ceec5f56e1a22215ea8ba9b57f6e7849c0acc` passed 395 suites and 3,866
tests, 136 visual tests and strict quality. Tracing additionally passed
39 focused tests and independent review. These results describe the
pre-retry baseline; subsequent integration checks and review are tracked
in the PR.

See [PR #430 checks](https://github.com/Chronote-gg/Chronote/pull/430/checks).
Production cost, latency and quality effects remain unmeasured.
