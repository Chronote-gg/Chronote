# Transcription retries and accounting implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Status:** Approved implementation plan. The checklist records the
2026-10-21 implementation handoff before post-change CI; PR checks and
review record subsequent validation.

**Goal:** Retry only transient snippet ASR failures and report attempted work honestly.

**Architecture:** One request helper owns each candidate's attempts and fresh
streams. A per-operation ledger tracks attempt-bound fetch hooks and known
usage, including failure/cancellation paths.

**Tech Stack:** Node.js 24.15.0, TypeScript, OpenAI 7.32.0, Cockatiel 4.0.0,
Bottleneck, Langfuse 5.13.1 and Jest.

**Spec:** [Transcription cost and latency design](../specs/2026-10-21-transcription-cost-latency-design.md).

## Global constraints

- Preserve audio, rendered prompts, effective models, model parameters, guards, voting and cleanup retention rules.
- Preserve saved recording v1 settings, durable checkpoints, notes generation and delivery ordering.
- Keep ASR concurrency 2, queue capacity 100 and logical-start spacing 800 ms; keep attachment concurrency 1 and spacing 0 ms.
- Allow at most 4 ASR attempts per candidate, including the first; disable SDK retries only for those snippet ASR requests.
- Keep text Responses, final-pass and personal-upload retry behavior outside this change.
- Use existing Langfuse observations for numeric diagnostics; add no content, identifiers or PostHog properties.
- Add no dependencies, rollout toggles, schema migrations or quality exceptions.

## Review focus

- A successful prompted candidate remains counted and is not repeated when its vote fails.
- Multipart preparation fails before HTTP dispatch.
- A provider returns known usage just before cancellation.
- An aborted queued job must not block a later eligible job.
- Retry exhaustion, timeout and lost responses have unknown billing where usage is unavailable.

## Files and responsibilities

- Create `src/services/transcriptionRequest.ts`: ASR classification, retry
  budget, backoff, fresh stream lifetime and request dispatch.
- Create `src/observability/transcriptionAttempts.ts`: attempt ledger,
  bound fetch hooks, aggregate counters and normalized failure metadata.
- Modify `src/services/openaiClient.ts`: optional typed fetch transport only.
- Modify `src/services/transcriptionInput.ts`: typed local input-error provenance
  after actual request/stream settlement, preserving unrelated request errors.
- Modify `test/services/transcriptionInput.test.ts`: causal read failure,
  cancellation and secondary teardown error precedence.
- Modify `src/services/transcriptionService.ts`: candidate-level request helper,
  selective breaker, remove outer retry, aggregate finally recording.
- Modify `src/observability/langfuseUsageDetails.ts`: optional attempt-aware
  cost completeness, preserving existing returned-response field semantics.
- Modify `src/constants.ts`: retain 3 retries and name backoff constants.
- Create `test/services/transcriptionRequest.test.ts`.
- Create `test/observability/transcriptionAttempts.test.ts`.
- Create `test/services/transcriptionPolicies.test.ts`.
- Modify `test/services/openaiClient.test.ts`,
  `test/observability/langfuseUsageDetails.test.ts` and
  `test/services/transcriptionSnippetResult.test.ts`.
- Re-run the tracing-overlap suite and existing input/lifetime regressions.

## Task 1: replace whole-workflow retries with owned ASR attempts

**Interfaces:**

- `TranscriptionCandidateId = "prompt" | "no_prompt"`.
- `TranscriptionInputError extends Error` is exported from transcriptionInput;
  its cause preserves the causal request/read error internally. The existing
  withTranscriptionInput signature and close-before-settlement contract remain.
- `createOpenAIClient(options?, transport?: Pick<ClientOptions, "fetch">):
OpenAI`, using the SDK's named `ClientOptions` export.
- `createTranscriptionAttemptLedger(audioSeconds?: number)` returns a ledger
  with `beginCandidate(candidate)`, `beginAttempt(candidate)` and
  `snapshot()`. Begin-attempt returns one attempt record with
  `markSdkInvocation(): void`,
  `wrapFetch(delegate: NonNullable<ClientOptions["fetch"]>)`,
  `recordReturnedUsage(usage: Transcription["usage"])` and
  `settle(outcome)`. Outcomes are a tagged success/failure value with a
  normalized enum/status, never an arbitrary Error.
- `runTranscriptionRequest(input): Promise<Transcription>` consumes
  `candidate`, `file`, `signal`, the existing model/prompt ASR request
  fields excluding file, the operation ledger and tracing client options.
  It also accepts optional `transport?: Pick<ClientOptions, "fetch">`.
  Its request type is
  `Omit<TranscriptionCreateParamsNonStreaming<"json">, "file">`.
- `createTranscriptionFailureScope()` supplies generic `run(callback)` over
  an operation-local WeakSet through AsyncLocalStorage.
- `isExhaustedTranscriptionFailure(error: unknown): boolean` requires current
  scope membership and the transient classifier while preserving error identity.
- `isTransientTranscriptionFailure(error: unknown): boolean` owns the
  normalized retry classification. The caller checks its signal first.
- `buildLangfuseTranscriptionAccounting(usages, fallbackAudioSeconds?,
attempts?)` accepts the ledger snapshot. Existing two-argument callers
  retain their behavior and the priced/partial/unpriced status union.

The ledger snapshot has logicalCandidateCount, sdkInvocationCount,
httpDispatchAttemptCount, retryCount, knownUsageAttemptCount,
unknownUsageAttemptCount, attemptUsageCoverage, optional
estimatedAttemptAudioSeconds, and returnedUsages. Counts are numbers;
returnedUsages is `Transcription["usage"][]`; coverage uses the spec's four
literal values. Prefix these property names with transcription when
recording the exact metadata keys in the spec, excluding returnedUsages.
That array is consumed only by usage accounting. Queue wait is recorded
separately by the orchestration.

Logical candidates count requested prompt/no-prompt operations; SDK
invocations count markSdkInvocation calls immediately before create, after
input preparation succeeds; HTTP dispatch attempts count fetch entries. Retry count sums
extra SDK invocations per candidate. A no-dispatch operation has
not_attempted coverage; any missing valid usage makes coverage partial or
unknown. Valid duration usage is known usage but does not establish token
pricing.

- [x] **Step 1: pin request, cancellation and accounting contracts.**

Use the real pinned OpenAI client with an injected fake fetch in the request
test. Mock file input at its own boundary with readable synthetic bytes.
Do not mock SDK retry behavior. Provide a local fixture
`buildAsrFixture({ outcomes, signal?, prompt? })` with calls, stream-open
and stream-close observations, ledger and `run()`.

```ts
test.each([408, 409, 429, 500, 503])(
  "retries transient HTTP %i once before success",
  async (status) => {
    const f = buildAsrFixture({ outcomes: [status, validAsrResponse] });
    await f.run();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.openedStreams).toHaveLength(2);
    expect(f.closedStreams).toHaveLength(2);
  },
);
test.each([400, 401, 403, 404, 422])(
  "does not retry terminal HTTP %i",
  async (status) => {
    const f = buildAsrFixture({ outcomes: [status] });
    await expect(f.run()).rejects.toBeDefined();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);
```

Add quota-429, x-should-retry false, misleading true-on-400, network error,
timeout and exhaustion tests. Exhausted transient input must yield exactly
4 HTTP dispatches and 3 retries with SDK maxRetries 0. Assert no extra fetch
occurs after the fourth response.

Use fake timers for backoff. Assert initial 128 ms, exponent 2 and max
30,000 ms generator configuration; control jitter rather than assert random
durations. Assert Retry-After precedence and inclusive 0/60,000 ms bounds,
plus malformed, negative, nonfinite, excessive and HTTP-date values.

Abort before stream open, while queued, during backoff, during issued work,
and after returned usage. Assert no new dispatch, immediate timer
interruption, actual issued-request/stream settlement and correct late-abort
outcome. Queue tests must use real pinned policies and release controlled
active work; a later eligible item must still execute.

Add a two-candidate integration contract:

```ts
expect(promptFetches).toBe(1);
expect(noPromptFetches).toBe(2);
expect(promptPreparation).toHaveBeenCalledTimes(1);
expect(attachmentPreparation).toHaveBeenCalledTimes(1);
```

Pin preservation of prompted usage when the vote exhausts or fails
permanently. Add a real-SDK fake fetch that consumes the multipart body and
encounters an EIO stream read error after fetch entry. Assert exactly one
dispatch, unknown usage, a terminal TranscriptionInputError, no retry or
breaker increment, and closed input. Separately assert a pre-fetch input
preparation failure has zero dispatches. An unrelated provider failure plus
a secondary stream teardown error must preserve provider error identity.
File/prompt/guard/attachment/bulkhead/breaker-open failures must not become
ASR retries or counted transient provider failures.

- [x] **Step 2: demonstrate failures before implementation.**

Run:

```bash
yarn test --runInBand test/services/transcriptionRequest.test.ts test/observability/transcriptionAttempts.test.ts test/services/transcriptionPolicies.test.ts
```

Expected RED: missing boundary/ledger or existing repeated workflow,
repeated successful candidates and retry-on-terminal behavior. The pinned
OpenAI 7.32.0 client suppresses its own retries for streaming multipart bodies,
so do not infer a current nested retry multiplier. Inspect pinned APIs and
record discrepancies before changing the agreed contract.

- [x] **Step 3: implement the single request owner and attempt ledger.**

Create one ledger per logical transcription and one backoff sequence per
candidate. Capture globalThis.fetch once in the request module and delegate
to an explicitly supplied transport when present; no prior captured fetch
existed. Within each attempt, create an attempt-bound fetch wrapper and
ASR client, open a fresh input, and call SDK create with signal/maxRetries 0.
Record returned usage before checking late cancellation. Settle the attempt
and close input on every outcome.

Extend withTranscriptionInput to retain the request outcome, drain the
stream, then identify a captured read error in a rejected request's
Error.cause chain. Wrap that causal input failure in TranscriptionInputError;
a successful request with an observed read error also remains a local
failure. Preserve unrelated request errors and cancellation over secondary
teardown errors. Use identity with a cycle-safe cause walk, not message or
provider status heuristics. Keep close-before-settlement and the current
callback signature. Check the operation signal before classifying any error,
then exclude TranscriptionInputError from retry and breaker predicates.

Use the spec's classification and retry delay rules. Advance the public
backoff generator each retry, including Retry-After overrides. Await an
abortable timer; never race an issued provider operation to early settlement.

Remove the outer Cockatiel retry import/policy. Keep bulkhead/limiter
ownership around the complete logical transcription and retain the breaker
threshold of 5 exhausted transient failures with 10,000 ms half-open delay.
Require operation-local exhausted-error membership and the same transient
predicate for breaker classification. Enter the failure scope around breaker
execution after bulkhead admission and again inside the limiter callback.
Keep explicit dequeued signal guards rather than change Cockatiel queue
cancellation.

Wire per-candidate requests so a successful prompted candidate is retained.
Flush ledger metadata/known usage in finally inside the existing generation,
including when the second candidate fails or late cancellation wins.
Preserve the prior tracing-overlap finally drain and success signal fence.

Extend usage accounting so no dispatched-but-unpriced attempt can leave cost
status priced. Existing requestCount/pricedRequestCount/unpricedRequestCount
continue to describe returned responses; new attempt fields describe the
additional work. Never synthesize zero billing for missing responses or use
estimated audio duration as provider token usage.

Measure logical queue wait with monotonic time around bulkhead and
logical-start limiter entry. Keep existing delivery timing untouched.
All new diagnostics are best effort and normalized as defined in the spec.

- [ ] **Step 4: verify actual dispatch and privacy behavior.**

In ledger/accounting tests, build partialAccounting from the transient-then-
success snapshot and its returnedUsages using the extended accounting builder.
Assert:

```ts
expect(localPreparationFailure.httpDispatchAttemptCount).toBe(0);
expect(transientThenSuccess.httpDispatchAttemptCount).toBe(2);
expect(transientThenSuccess.knownUsageAttemptCount).toBe(1);
expect(transientThenSuccess.unknownUsageAttemptCount).toBe(1);
expect(transientThenSuccess.attemptUsageCoverage).toBe("partial");
expect(partialAccounting.status).toBe("partial");
expect(noDispatch.attemptUsageCoverage).toBe("not_attempted");
expect(JSON.stringify(diagnostics)).not.toContain(secretSentinel);
```

Add both-token-candidate sum, duration-only usage, invalid/NaN/negative usage,
prompted success plus vote failure, and returned usage before late abort.
No HTTP dispatch must yield no inferred billed amount. A native fetch
rejection after its hook is an HTTP dispatch with unknown usage.

Verify client API key/org/project forwarding, injected fetch delegation,
unchanged default client options and unchanged Responses SDK retry behavior.
Inject a synthetic error containing header/body/path/identifier sentinels
and assert none enters new diagnostic metadata. Observation/logger failure
must not replace the ASR result.

Run:

```bash
yarn test --runInBand test/services/transcriptionRequest.test.ts test/observability/transcriptionAttempts.test.ts test/services/transcriptionPolicies.test.ts test/services/openaiClient.test.ts test/observability/langfuseUsageDetails.test.ts test/services/transcriptionSnippetResult.test.ts test/services/transcriptionTracing.test.ts test/services/transcriptionInput.test.ts test/services/meetingProcessingLifetime.test.ts test/commands/endMeetingNotesLatency.test.ts
yarn test --runInBand
yarn build
yarn lint:check
yarn prettier:check
yarn markdownlint:check
yarn check:quality
```

Expected GREEN. Run remaining required repository/CI checks and independent
whole-change review. Keep all tests synthetic; no paid replay is required
to prove request bounds and lifecycle behavior.

- [ ] **Step 5: commit and hand off measured verification.**

Commit `[AGENT] fix: bound transient ASR retries and account attempted work`.
Audit current PR checks and review feedback. Inspect actual metadata on a
permitted test run before relying on cost-completeness labels operationally.
Deployment, live baselines and model/quality experiments remain separate
authorized work; this plan does not claim dollar or latency savings.

## Execution evidence and consequences

The initial tests-only commit `ee09a07e8e246f275ad3401decaeca2d6de2d665`
produced 55 failures and 47 passes. After fixing the audited queue-admission,
accounting-failure and classifier-premise tests,
`68652d426b03ea71a659ecba66a3c8847019df2f` produced 56 failures and 47
passes across 7 failed and 3 passed suites in 29.636 seconds. Build, lint,
formatting, Markdown and census passed. The independent test audit accepted
all three repairs. These are pre-implementation results recorded on
2026-10-21; subsequent checks and review are tracked in the PR.

The four-attempt budget applies independently to each candidate, allowing
eight ASR attempts across both. It can change recovery opportunity and
worst-case work relative to the prior whole-workflow budget. Keeping a
successful prompted candidate avoids repeating that work when its vote
retries; no universal cost or latency improvement follows.

Follow [PR #430 checks](https://github.com/Chronote-gg/Chronote/pull/430/checks)
for validation. Production cost, latency and quality effects remain
unmeasured and require a separate operational comparison.
