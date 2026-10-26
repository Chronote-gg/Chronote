# Transcription cost and latency design

Date: 2026-10-21
Status: Accepted design. Historical execution evidence is recorded below.
Source baseline: PR #430, commit `3ef9548fd6523f33cdd80857c562a320108f89bc`.

## Intent and success criteria

The user requested designs and plans for three additions to PR #430:
reuse successful identical cleanup, overlap tracing attachment preparation with
ASR, and retry transient ASR failures with accurate attempt accounting.

Reduce unnecessary provider work and request-start delay while preserving
transcription inputs, candidate selection, cleanup acceptance and durable
recovery. Success means one cleanup execution for two equivalent compilations,
ASR dispatch before independent attachment preparation finishes, and a bounded
retry policy that never repeats a successful prompted candidate to retry its
no-prompt counterpart. Tests establish these contracts; live savings remain
unmeasured until an operational comparison is performed.

## Global constraints

- Preserve audio, rendered prompts, effective models, model parameters, guards, voting and cleanup retention rules.
- Preserve saved recording v1 settings, durable checkpoints, notes generation and delivery ordering.
- Keep reusable cleanup results inside one normal finalization; never persist them or share them across meetings.
- Keep ASR concurrency 2, queue capacity 100 and logical-start spacing 800 ms; keep attachment concurrency 1 and spacing 0 ms.
- Allow at most 4 ASR attempts per candidate, including the first; disable SDK retries only for those snippet ASR requests.
- Keep text Responses, final-pass and personal-upload retry behavior outside this change.
- Use existing Langfuse observations for numeric diagnostics; add no content, identifiers or PostHog properties.
- Add no dependencies, rollout toggles, schema migrations or quality exceptions.

## Baseline behavior and ownership

`audio.ts:1260-1356` compiles a transcript, optionally adds cues and runs
cleanup. Normal finalization invokes it at `endMeeting.ts:554` for notes and
again at `:619` for upload. Both calls can clean the same text. Cleanup prompt
construction also reads context, participants, roles and events, so transcript
identity alone is insufficient.

`transcriptionService.ts:566-597` waits for limiter-scheduled tracing attachment
preparation before ASR starts. The attachment uses ffmpeg and file reads.
`meetingProcessingLifetime.ts:31-64` owns the complete effect chain and drains
issued effects. The snippet owner deletes PCM/WAV files after transcription
settles. Attachment preparation currently cannot cancel running ffmpeg.

`transcriptionService.ts:713-746` wraps the entire transcription in a
Cockatiel retry, breaker and bulkhead. The pinned OpenAI 7.32.0 SDK disables
its own retries for streamed multipart inputs such as these ReadStreams.
The outer retry can repeat preparation and a successful prompted candidate
after a no-prompt request fails. Returned-candidate usage does not describe
every transport dispatch. These are the pre-implementation source behaviors.

Stop-to-first and complete acknowledged notes timing already exists. Use
`meetingNotesLatency.ts` and its documented coverage rules rather than create
another timing lifecycle. This design does not claim that source telemetry
proves deployed coverage or measured user wait.

## 1. Cleanup reuse

### Chosen shape

Move compilation into `services/transcriptCompilationService.ts` and cleanup
preparation/execution into `services/transcriptionCleanupService.ts`.
Remove the moved exports from `audio.ts` and `transcriptionService.ts`, and
migrate callers and mocks in the same change. This also shrinks both oversized
source files.

Provide:

```ts
type CompileTranscriptionsOptions = {
  includeCues?: boolean;
  cleanupAcknowledged?: (
    outcome: "acknowledged" | "fallback" | "disabled",
  ) => void;
};
type MeetingTranscriptCompiler = (
  options?: CompileTranscriptionsOptions,
) => Promise<string>;

declare function createMeetingTranscriptCompiler(
  client: Client,
  meeting: MeetingData,
): MeetingTranscriptCompiler;
declare function compileTranscriptions(
  client: Client,
  meeting: MeetingData,
  options?: CompileTranscriptionsOptions,
): Promise<string>;
```

The standalone function uses the same implementation with a fresh lifetime.
Normal finalization constructs one compiler before its first compilation and
uses it for both existing stages. Cancellation artifact compilation remains a
standalone call. No compatibility re-exports remain in the old modules.

The cleanup module owns `prepareTranscriptionCleanup(meeting, transcription)`,
`cleanupContentTranscription(content, prompt, model, parentSpanContext?)` and
`retainCleanupTranscript(original, cleaned, minimumLineRatio)`. Retain the
existing frozen model and prepared prompt types. Delete the old live
`cleanupTranscription` wrapper once its caller has migrated.

### Identity and admission

Each compiler holds at most one settled, accepted result. Each call still
captures the selected transcript scope synchronously before its first await,
then formats the current segments and prepares the current cleanup request.

Compare copied value snapshots using `isDeepStrictEqual` from `node:util`.
The key contains the exact formatted transcript, rendered messages, prompt
name/version/fallback provenance, effective model and resolved parameters, and
retention ratio. Copy plain request values and the provenance fields; never
clone a Langfuse client. Equivalent parameter key insertion order may hit.

A hit returns the accepted text with the existing header and acknowledgement.
A changed transcript, cue, speaker label, timestamp, prompt or setting misses.
Preserve existing truthiness semantics: whitespace cue text is meaningful.

Admit a result only when the existing retention rule returns the cleaned text.
A successful unchanged transcript is admissible. Provider failure, retention
rejection, empty input, disabled cleanup and in-flight work are never cached.
A failed first compilation leaves the second its existing retry opportunity.

Check the current processing signal before preparation, before reuse/provider
dispatch, after settlement and before admission/return. Keep all work awaited.
A new finalization or recovery attempt always gets a fresh compiler. Recovery
continues to execute its saved v1 prompt/settings and durable processed-text
checkpoints independently.

Record `transcriptionCleanupReuseHit` on the existing compilation observation
as best-effort metadata. A hit must not fabricate a provider generation.

### Cleanup alternatives

A transcript-only key ignores mutable prompt inputs. A process cache or
WeakMap keyed by meeting gives reuse an unnecessarily broad lifetime.
Formatting once and appending cues after cleanup changes request behavior.
The finalization-owned compiler gives reuse one explicit, bounded owner.

## 2. Overlap tracing preparation and ASR

Keep this change inside the existing active transcription observation.
Start the current complete `meeting.effect(...schedule...then(update)...catch)`
attachment chain and attach its terminal nonthrowing handler immediately.
Store its handled `Promise<void>` without awaiting it before ASR.

Run ASR, selection and usage recording in a try block. Drain the attachment
promise in finally, inside the generation callback. On success, perform a
final `meeting.signal.throwIfAborted()` and return selected text only after
that finally. This covers cancellation after ASR succeeds while attachment
work is still draining.

Preserve the queued-start abort fence and current limiter values. Started
ffmpeg work must settle before its files and active observation are released.
Attachment, observation-update or attachment-warning failures must never
replace a provider error or turn a successful ASR operation into a failure.

Pinned Langfuse 5.13.1 flattens metadata into independent OTEL attributes.
Attachment input already spreads the original observation input; selection
updates do not replace input. Keep the existing complete owned chain rather
than introduce detached callbacks or a second observation.

Independent work changes the serial preparation-plus-ASR wait toward their
maximum, subject to scheduling and CPU contention. The bulkhead slot still
remains occupied until the attachment drain completes; this does not promise
full throughput isolation from tracing backlog.

Reject detached background work and `Promise.all` as lifecycle solutions:
provider rejection must not release the WAV or generation before attachment
settlement. Moving tracing to another worker or sampling attachments is
separate work.

## 3. ASR retry owner and accounting

### Request boundary and budget

Add `services/transcriptionRequest.ts` for one candidate's provider operation.
Remove the whole-workflow retry from `transcriptionService.ts`. Retain the
existing bulkhead and a breaker around each complete logical transcription.
The breaker handles only the transient provider failures defined below and
counts an exhausted transcription once, not every internal attempt.

The internal `createTranscriptionFailureScope()` returns generic
`run(callback)`. Its operation-local WeakSet, accessed through Node
AsyncLocalStorage, records only the final exhausted transient ASR Error.
`isExhaustedTranscriptionFailure(error)` requires current-scope membership
and the shared transient classifier. Rethrow the original error object.
Enter the scope around breaker execution after bulkhead admission and again
inside the Bottleneck callback: queued schedulers can otherwise inherit the
releasing job's context. Non-ASR errors never acquire ASR provenance.

A candidate has 3 retries, at most 4 total attempts. Each attempt opens a fresh
input through `withTranscriptionInput` and issues ASR with
`{ signal, maxRetries: 0 }`. Prepare prompt/model/guards once per logical
transcription. Retain a successful prompted candidate while retrying its
no-prompt candidate. Local preparation, guard, prompt, attachment, queue and
breaker-open errors do not cause ASR retries.

Retry OpenAI connection/timeouts and HTTP 408, 409, 429 and 500-599.
Cancellation, other 4xx, 429 with `insufficient_quota`, and unrelated errors
are terminal. A provider `x-should-retry: false` prevents retry; true never
overrides terminal exclusions. Check cancellation before classification.

Use Cockatiel's public `ExponentialBackoff` generator with initial 128 ms,
exponent 2, maximum 30,000 ms and its existing decorrelated jitter. Create
the sequence per candidate and advance it each retry. Drive waits using
abortable `node:timers/promises` timers, not Cockatiel's retry sleep.

Honor `retry-after-ms`, then `retry-after` seconds/date, with the pinned
SDK's inclusive valid interval 0-60,000 ms. Invalid or missing values use
jitter backoff. This is an attempt limit, not an end-to-end deadline.
The existing SDK request timeout is unchanged.

Local input provenance is part of this boundary. The SDK lazily reads
multipart audio during fetch and can wrap a read failure as a connection
error. Extend withTranscriptionInput to expose a typed TranscriptionInputError
after the request and stream actually settle. When a request rejects,
recognize the captured stream error by identity in its Error.cause chain,
not by provider-message text; when a request succeeds, preserve the current
rule that an observed read failure still fails the operation. Preserve
unrelated request errors and cancellation errors rather than replace them
with secondary teardown errors. Classify the typed input failure as terminal
before the connection-error predicate. Test both pre-fetch and during-fetch
read failures using the real pinned SDK and a consuming fake transport.

Keep bulkhead scheduling unchanged and fence dispatch inside dequeued work.
Cancellation forbids new provider dispatch and interrupts backoff. It does
not promise immediate retirement of queued work. Never race issued work
against cancellation and declare its owned effect settled early.

### Client and attempt ledger

Add optional `Pick<ClientOptions, "fetch">` transport options as a second
argument to `createOpenAIClient`, forwarding them to its base constructor.
Use the SDK's named `ClientOptions` export. Existing callers retain their
defaults. Never access private `client.fetch` or mutate global fetch.

Each retry iteration creates an attempt record and an ASR client whose fetch
wrapper is bound to that record. Capture `globalThis.fetch` once in transcriptionRequest.ts as the default
delegate; there was no prior captured native fetch. The internal request input
also accepts optional `transport?: Pick<ClientOptions, "fetch">` for an
explicit delegate. This avoids a shared mutable "current attempt" pointer. Keep
the single existing manual generation observation for the whole transcription.

Add `observability/transcriptionAttempts.ts` for a per-operation ledger.
Its public concepts are candidate `"prompt" | "no_prompt"`, an SDK invocation,
an HTTP dispatch and a settled attempt. HTTP dispatch means fetch invocation,
not proof that a provider received or billed it.

Record returned usage before the post-response cancellation check. Flush the
ledger in finally on success, terminal failure and cancellation. Preserve
known prompted usage when a later vote fails.

Expose numeric aggregate metadata:

- `transcriptionLogicalCandidateCount`.
- `transcriptionSdkInvocationCount`.
- `transcriptionHttpDispatchAttemptCount`.
- `transcriptionRetryCount`, actual extra SDK invocations per candidate.
- `transcriptionKnownUsageAttemptCount`.
- `transcriptionUnknownUsageAttemptCount`.
- `transcriptionAttemptUsageCoverage`: not_attempted, complete, partial or unknown.
- `transcriptionEstimatedAttemptAudioSeconds`, only when duration is known.
- `transcriptionQueueWaitMs`, bulkhead plus logical-start limiter wait.

SDK invocation and HTTP dispatch are distinct: multipart preparation can fail
before fetch. Attempted audio duration is an estimate, not reported billing.
Usage coverage counts validated token or duration usage; cost completeness
requires priced token usage for every HTTP dispatch.

Extend `buildLangfuseTranscriptionAccounting` with an optional attempt summary.
Keep existing request-count fields describing returned SDK responses, and
keep existing priced/partial/unpriced enum values. With an attempt summary,
never label cost priced when any dispatched attempt lacks priced usage.
Sum only valid reported tokens and keep audio-duration estimates separate.
Missing usage means unknown cost, never zero cost.

Record attempt aggregates inside an existing generation when one starts.
Cancelled queue work must issue no HTTP request; do not fabricate provider
generations for work that never dispatches. Coverage describes observed
attempts, not a new complete meeting-failure reporting system.

New per-attempt diagnostics allow only counts, candidate enum, normalized
failure enum, HTTP status and delay. Do not export request bodies, headers,
prompts, transcripts, paths, raw errors or new identifiers. Diagnostics must
be best effort and must not replace the operation's result.

### Retry alternatives

Selective outer retries retain duplicated successful candidate work.
SDK-only retry ownership does not supply the selected classification and
budget; the pinned SDK suppresses retries for these streaming bodies.
A single ASR request owner gives the budget, stream lifetime and accounting
one boundary.

Four attempts per candidate permit up to eight ASR attempts when both
candidates need their full budgets. Compared with the previous single
whole-workflow budget on streamed inputs, this can change recovery opportunity
and worst-case work. The concrete avoided work is repeating a successful
prompted candidate solely to retry its vote. It is not a claim that every path
gets cheaper or faster. Operational acceptance must compare transcription
failure and partial delivery rates alongside latency and known usage. Keep
the failure/recovery path intact when a candidate exhausts its budget.

The lock pins Cockatiel 4.0.0 and OpenAI 7.32.0. Inspect installed pinned
behavior during execution and test real SDK/policy objects; current mocks
do not prove retry, queue or stream semantics. No dependency upgrade is part
of this design.

## Implementation order and validation

1. [Cleanup reuse plan](../plans/2026-10-21-transcription-cleanup-reuse.md).
2. [Tracing overlap plan](../plans/2026-10-21-transcription-tracing-overlap.md).
3. [ASR retry and accounting plan](../plans/2026-10-21-transcription-retries.md).

Execute sequentially because all three touch transcription-related source,
and the last two share ASR control flow. Each produces an independently
testable commit. Re-run tracing lifetime tests after retry integration.

Use synthetic fixtures and controllable promises. Run focused tests first,
then required repository checks. Test known/invented mentions and frozen
recovery settings as regressions. Review all moved imports and mocks; do not
grow oversized files or retain obsolete exports.

Verify actual known-usage totals, request/reuse counts and request-start
ordering before claiming improvement. Later operational comparisons should
use matched meeting cohorts and existing first/complete delivery timing,
including failure, partial, pending and unknown coverage. No percentage,
dollar or user-wait reduction is established by this planning change.

## External contracts checked

- [OpenAI Node 7.32.0](https://github.com/openai/openai-node/tree/v7.32.0):
  request maxRetries, ClientOptions, fetch and Retry-After behavior.
- [Langfuse 5.13.1 tracing](https://github.com/langfuse/langfuse-js/tree/v5.13.1/packages/tracing):
  active observation lifetime and independent metadata attributes.
- [Cockatiel version-4 source](https://github.com/connor4312/cockatiel/tree/0731c99f39cc7d88ba3cba89bb19f0e453321e42):
  public backoff generator and policy behavior. Verify installed package
  behavior before execution; this source pointer is not a tarball-integrity claim.

## Implementation evidence recorded on 2026-10-21

Cleanup reuse and tracing overlap are implemented and were validated before
retry integration. The integrated baseline
`5e9ceec5f56e1a22215ea8ba9b57f6e7849c0acc` passed 395 suites and 3,866
tests, 136 visual tests and strict quality checks. Tracing separately passed
39 focused tests and independent review.

Retry tests at `ee09a07e8e246f275ad3401decaeca2d6de2d665` demonstrated
RED (55 failures, 47 passes). After formatting and independent test-audit
repairs, `68652d426b03ea71a659ecba66a3c8847019df2f` demonstrated
strengthened RED (56 failures, 47 passes) with build, lint, formatting and
Markdown passing. These RED counts describe pre-implementation evidence;
current implementation checks and review are tracked in the PR.

See [PR #430 checks](https://github.com/Chronote-gg/Chronote/pull/430/checks)
and [the combined ADR](../../adr-20261021-transcription-pipeline-work.md).
Production dollar, latency and quality comparisons remain unmeasured.
