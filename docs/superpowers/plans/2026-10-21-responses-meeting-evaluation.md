# Responses API and meeting model evaluation plan

Date: 2026-10-21

## Goal

Implement the [design](../specs/2026-10-21-responses-meeting-evaluation-design.md)
with one Responses request boundary for all text callers. Remove the old Chat
Completions branch, transport configuration and obsolete compatibility tests.
Keep model defaults, saved recording schemas, prompts and billing unchanged.

## Task 1: prove the required default

Require ordinary meeting text calls to use Responses without an opt-in.
Retain completion, refusal, filtered-output, empty-output, continuation,
cancellation and frozen-parameter contracts. Existing initial migration tests
first produced 12 failures with 3,646 baseline tests passing; the Responses-only
default receives its own regression assertion.

## Task 2: simplify the boundary

Keep openaiTextService.ts as the only SDK text dispatch boundary. Accept native
Responses input items and the existing frozen-style model parameters. Support
text, JSON object and strict JSON schema formats with store:false.

Delete the transport selector and Chat request/continuation implementation.
Export the shared meeting text request budget from the service rather than a
transport configuration module. Preserve complete SDK item replay, refusal and
terminal-state checks, repeated-chunk rejection and cancellation.

## Task 3: migrate every caller

Use the service for notes, cleanup, coalescing, final-pass reconciliation,
summaries, Discord/web corrections, personal-upload notes, the notes evaluator,
Ask, live-voice gate/replies/confirmation, image captions, dictionary suggestions
and auto-record cancellation decisions.

Preserve prompt construction, frozen settings, token caps, tracing metadata,
mention allowlists, citations, image detail, cancellation and each caller's
actual error behavior. Audio transcription, speech and image-generation
endpoints remain dedicated to their respective media operations.

Update SDK fixture shapes and assertions for input, reasoning.effort, text.format
and max_output_tokens. Keep meaningful fallback, privacy, mention, cancellation
and recovery tests exercising the shared service.

## Task 4: keep model evaluation separate

Retain the GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna and GPT-6 Astra capability profiles.
Do not change default role models as part of the API migration.

Capture the existing-model baseline from the prior source revision, then compare
the same model on Responses before comparing newer models. Historical API
comparisons run from separate revisions or worktrees, not a production toggle.

## Task 5: validate and review

Run unit, build, lint, format, Markdown, documentation, quality-ratchet and
integration checks. Request independent review of the full cleanup and address
material findings. Keep the PR in draft until validation completes.

The local execution environment has been unavailable. Existing GitHub CI supplies
executable verification when it remains unavailable; do not add workflow or
quality exceptions.

## Paid evaluation stage

Use fixed prompt versions, identical rendered inputs and distinct experiment
names. Verify the traced model and effective parameters for each run.

- NOTES_MODEL=gpt-5.2 on Responses.
- NOTES_MODEL=gpt-6.1-sol on Responses with low reasoning.
- NOTES_MODEL=gpt-6-luna on Responses with the chosen none or low profile.
- A separately reported difficult-meeting experiment for Astra.

The summary's 160-token budget includes reasoning. Record a suitable independent
budget before comparing models that require reasoning. Existing mention graders
verify formatting and mention contracts, not factual meeting quality.

Curate representative permitted recordings and a separate challenge set before
full-pipeline replays. Measure audio-grounded facts, decisions, actions, owners,
deadlines, unsupported claims, complete cost and delivered-notes latency.
Source tests cannot establish savings or quality parity.

Strict schema adoption, combined notes/title/summary generation, duplicate
cleanup removal and selective final verification are separate experiments.

## Rollback

Revert the source migration if necessary. Restore prior role model choices to
roll back model experiments. Existing saved recording v1 settings remain readable.
