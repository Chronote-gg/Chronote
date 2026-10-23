# ADR-20261022: Sol notes defaults and cache policy

Status: Accepted  
Date: 2026-10-22  
Owners: Notes pipeline

## Context

Notes generation, meeting summaries, notes corrections, transcription cleanup
and image prompts previously shared the `NOTES_MODEL` default. Moving notes to
GPT-6.1 Sol should not change the other roles or settings frozen for existing
recordings.

Meeting transcripts are usually unique. The current notes prompt places dynamic
context early, so it does not expose a cache-eligible pure static prefix without
changing prompt layout and saved prompt snapshots.

## Decision

- Default notes generation to `gpt-6.1-sol`. Scope `NOTES_MODEL` to notes only,
  with the existing `models.notes` override. Keep `gpt-5.2` defaults for
  `models.meetingSummary`, `models.notesCorrection`,
  `models.transcriptionCleanup` and `models.imagePrompt`.
- Default notes to low reasoning and omit temperature. Honor compatible explicit
  model-parameter overrides and keep frozen DynamoDB v1 model, parameter and
  prompt snapshots authoritative.
- Send `prompt_cache_options: { mode: "explicit", ttl: "30m" }` with no
  `prompt_cache_breakpoint` markers for notes Responses requests using supported
  model profiles, including GPT-6.1 Sol. Apply the same policy to every
  continuation. Older overrides omit unsupported cache fields.
- Preserve prompt content ordering and input semantics. Defer static-prefix
  optimization to a separate design that addresses prompt layout and snapshots.
- Improve notes guidance for explicit assignments, volunteered follow-ups,
  stated owners and deadlines, and qualified or completed status. Instruct the
  model to make a silent completeness check within the same generation call.

## Consequences

New recordings inherit the notes default unless an override applies. Saved
recordings retain their frozen settings, and changing `NOTES_MODEL` no longer
changes other roles.

This policy disables implicit caching. With no breakpoints, notes requests do
not read or write the prompt cache. A future reusable-prefix design can use the
30-minute TTL, but this change makes no claim about cache savings. The silent
check is prompt guidance, not validation, and adds no model request.

## Alternatives Considered

- Change every role that inherited `NOTES_MODEL`. Rejected because the notes
  model decision does not establish defaults for the other workloads.
- Cache the full transcript. Rejected because unique transcripts do not justify
  cache writes.
- Reorder the prompt to create a reusable static prefix now. Deferred because it
  changes prompt composition and requires a separate compatibility review.
- Add a second model pass for action completeness. Rejected in favor of guidance
  within the existing notes request.

## Notes

Deterministic checks verify request contracts and snapshot compatibility.
Synthetic action-item fixtures support manual semantic review, not an automated
quality claim. See [the notes eval guide](notes-eval.md#action-item-semantic-review).

Prompt promotion follows the existing deployment workflow after merge.
