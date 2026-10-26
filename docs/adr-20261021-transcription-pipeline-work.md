# ADR-20261021: Transcription Work Ownership

Status: Accepted  
Date: 2026-10-21  
Owners: Audio pipeline

## Context

Normal finalization compiled the transcript for notes and again for upload,
potentially repeating identical accepted cleanup. Snippet ASR waited for
independent tracing audio preparation. A whole-workflow retry could repeat
a successful prompted candidate when its no-prompt vote failed, while
returned-response usage omitted failed or lost attempts.

## Decision

1. Own one compiler per normal finalization. Reuse only a settled,
   retention-accepted cleanup with matching transcript, rendered prompt,
   provenance, effective model, parameters and retention ratio. Recovery
   retains its saved v1 inputs and independent durable checkpoints.
2. Overlap tracing attachment preparation with ASR inside the same generation.
   Drain the complete attachment chain before releasing files or the
   observation, then check cancellation before publishing success.
3. Give each snippet ASR candidate at most four attempts, fresh streams and
   explicit transient classification. Disable SDK retries for those requests
   only. Keep a successful prompted result while retrying its vote.
   Scope exhausted provider-error membership per logical operation so the
   breaker preserves error identity and excludes prompt/guard/input failures.
   Keep the bulkhead, queue, start spacing and attachment limits unchanged.
4. Record attempt-bound fetch entries and known returned usage in a ledger.
   Flush best-effort accounting on success, failure and cancellation. Missing
   usage remains unknown cost; local audio estimates remain separate from
   provider usage.

## Consequences

Equivalent successful cleanup and a successful prompted candidate can be
reused without changing their effective request or selected output. Overlap
removes a serial dependency, but attachment drainage still occupies the
logical transcription slot and running encoding must finish.

Four attempts per candidate permit up to eight ASR calls across two
candidates. This can change recovery opportunity and worst-case work compared
with the prior single whole-workflow budget on streamed inputs. The pinned
OpenAI 7.32.0 SDK already suppresses retries for streaming multipart bodies;
the change does not establish a current nested retry multiplier or universal
savings. Operational acceptance must compare failures, partial delivery,
known usage and latency together.

The attempt ledger distinguishes SDK invocation, fetch entry and returned
usage. A fetch entry does not establish provider receipt or billing. Numeric
diagnostics add no content or identifiers and cannot replace the operation's
result.

## Alternatives Considered

- A process-wide cleanup cache would cross meeting and recovery lifetimes.
  A transcript-only key would ignore mutable prompt and model inputs.
- Detached attachments could outlive owned files or observations.
- Whole-workflow retry repeats successful candidates. SDK-only retry does
  not provide the selected classification, budget and accounting boundary.

## Notes

Cleanup/tracing and their integrated pre-retry baseline passed 395 suites,
3,866 tests, 136 visuals and strict quality. Strengthened retry RED at
`68652d426b03ea71a659ecba66a3c8847019df2f` passed build, lint, formatting
and Markdown while 56 tests failed as expected before implementation.
These results record pre-implementation evidence from 2026-10-21.
[PR #430 checks](https://github.com/Chronote-gg/Chronote/pull/430/checks)
provide current implementation validation; the PR records final review.

Production dollar, latency and quality comparisons remain unmeasured.
Deployment and live comparison are separate work.
