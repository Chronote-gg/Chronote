# Responses API and meeting model evaluation design

Date: 2026-10-21

## Goal

Use one Responses API path for OpenAI text generation and evaluate current models
on representative meeting inputs. Delete the superseded Chat Completions request
path and transport selector after migrating all internal callers.

Preserve saved recording settings, notes formatting, mention validation,
cancellation, tracing and feature-specific failure behavior. Keep model selection
separate from the API migration so its quality and cost effects can be measured.

## Source and contracts

- OpenAI SDK 7.32.0 and Langfuse 5.13.1 are already pinned.
- Saved recording v1 settings freeze model names, resolved parameters and prompt
  templates. Keep them readable and translate parameters at the request boundary.
- Existing model defaults remain unchanged. Current overrides require separate
  verification and are not inferred from repository defaults.
- Text generation includes meeting notes, cleanup, coalescing, final-pass
  reconciliation, summaries, corrections, personal uploads, the notes evaluator,
  Ask, live-voice decisions and replies, image captions, dictionary suggestions
  and auto-record cancellation decisions.
- Audio transcription, speech synthesis and image generation retain their
  dedicated SDK endpoints.

## Shared request boundary

All text callers use openaiTextService.ts. It accepts Responses-native input
items, the model, frozen-style parameters, tracing context, declared output format,
output-token budget, continuation budget and abort signal. There is no transport
setting or compatibility branch.

Map reasoning_effort to reasoning.effort, verbosity to text.verbosity and output
budgets to max_output_tokens. Keep requests stateless with store:false. Preserve
plain Markdown for notes and support JSON object and strict JSON schema formats.
Image captions use native input_text and input_image items with the existing low
image detail.

Use the SDK output_text helper and inspect completion status and refusal items.
A response may include reasoning before assistant text. Return usable text only
after successful completion.

Keep conversation context local. Do not introduce Conversations,
previous_response_id, background jobs or hosted tools.

## Continuation and cancellation

Single-call callers retain their existing request budget. Production notes and
the notes evaluator share a named budget of three SDK calls. Provider retries may
add HTTP attempts, cost and latency within each call.

Continue only text output stopped by max_output_tokens with usable text.
Replay complete typed output items through the pinned SDK helper so encrypted
reasoning and assistant metadata survive. Copy the input array before appending
continuation context.

Reject declared JSON truncation, refusals, filtered or empty output, failed
states, identical consecutive chunks and exhausted budgets. Never publish the
accumulated prefix after failure. The repetition check does not remove overlaps
or establish semantic progress. Prompt-only requests for JSON still use the text
format; callers must declare a structured format for the JSON truncation guard.

Pass cancellation to every SDK request and check it after settlement. Preserve
each caller's existing behavior on errors, including fail-safe live-voice
decisions and correction fallbacks. Completed-empty auto-cancellation output
means no cancellation, preserving meeting finalization; provider, refusal,
incomplete and malformed-result errors still propagate. Ask rejects empty answers
through its existing error UI instead of returning a blank response.

## Current model support

Provide GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna and GPT-6 Astra profiles without changing
model defaults.

GPT-6.1 Sol and Astra require reasoning and cannot receive temperature sampling
parameters. GPT-6 Sol and Luna support explicit none reasoning. Resolve unsupported
minimal reasoning to low for these new models. Preserve existing GPT-5 behavior.

## Evaluation sequence

1. Capture the existing model's baseline from the pre-migration revision.
2. Use the same model, prompt and effective parameters on Responses.
3. Compare GPT-6.1 Sol with low reasoning on Responses.
4. Compare GPT-6 Luna with an appropriate none or low reasoning profile.
5. Report Astra separately on the difficult-meeting set.

Run historical transport comparisons from separate revisions or worktrees.
Do not retain obsolete production request paths for evaluation.

Evaluate strict schemas, combined notes/title/summary generation, duplicate
cleanup removal and selective final verification as separate experiments.

Use representative permitted recordings plus a separate challenge set,
preserving audio, chat, context, roster, prompts and settings. Human audio-grounded
checks must cover material facts, decisions, actions, owners and deadlines.
Mention and word-error checks do not establish factual note quality.

Record complete cost including retries and fallbacks, usage coverage, reasoning
and cached-token details, failures and recording-stop-to-delivered usable notes.
Provider duration alone does not measure user wait. The summary's existing
160-token budget includes reasoning; choose and record a suitable budget before
testing models that require reasoning.

## Validation and rollback

Test the Responses-only default, request conversion, terminal states,
continuation, cancellation, frozen parameters, mentions and direct caller
integration. Update SDK fixtures and request assertions; delete selector tests
and Chat-only compatibility tests. Run repository CI and independent review.

Paid quality replays, prompt promotion, production deployment and model-default
changes are separate from this source migration. Roll back code by reverting the
migration commit; roll back model experiments by restoring prior role choices.
Saved recording v1 settings need no migration.

## References

- [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Current model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Langfuse OpenAI integration](https://langfuse.com/integrations/model-providers/openai-js)
