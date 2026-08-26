# GPT-5.6 text-model migration

This migration changes Chronote's text and vision-to-text defaults without
changing audio, transcription, text-to-speech, or image-generation providers.
It follows the current [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and preserves the existing Chat Completions request and output contracts.

No production configuration has been changed or deployed by this work.

## Current usage inventory and target mapping

| Workload role                                                 | Previous default | Target          | Endpoint and contract                                                                                                       | Effective reasoning and role                                                         |
| ------------------------------------------------------------- | ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Meeting notes, personal-upload notes, notes eval              | `gpt-5.2`        | `gpt-5.6-sol`   | Chat Completions; Markdown text, mention allowlist sanitization, continuation on `length`                                   | Temperature mode forced reasoning `none`; flagship quality path                      |
| Meeting summary                                               | `gpt-5.2`        | `gpt-5.6-sol`   | Chat Completions; JSON object parsed into bounded sentence and label fields; errors return an empty summary                 | Temperature `0`, reasoning `none`; quality-sensitive user-facing summary             |
| Notes correction, Discord and web                             | `gpt-5.2`        | `gpt-5.6-sol`   | Chat Completions; corrected Markdown, code-fence stripping, mention allowlist sanitization; failure preserves current notes | Temperature `0`, reasoning `none`; fidelity is more important than throughput        |
| Transcription cleanup                                         | `gpt-5.2`        | `gpt-5.6-sol`   | Chat Completions; cleaned transcript text with the shared continuation behavior                                             | Temperature `0`, reasoning `none`; transcription-adjacent quality path               |
| Image prompt generation                                       | `gpt-5.2`        | `gpt-5.6-sol`   | Chat Completions; plain image prompt consumed by the unchanged DALL-E request                                               | Temperature `0.5`, reasoning `none`; creative quality path                           |
| Meeting Q&A                                                   | `gpt-4o-mini`    | `gpt-5.6-terra` | Chat Completions; answer text plus deterministic meeting citations                                                          | Temperature `1`, reasoning `none`; balanced interactive path                         |
| Live voice responder                                          | `gpt-4o-mini`    | `gpt-5.6-terra` | Chat Completions; text capped at 200 completion tokens; failures produce no spoken reply                                    | Temperature `1`, reasoning `none`; balanced latency and response quality             |
| Live voice gate and command confirmation                      | `gpt-5-mini`     | `gpt-5.6-luna`  | Chat Completions; bounded JSON action/decision; invalid, empty, or failed output becomes no action                          | Explicit `low`; latency-sensitive, high-volume classifier                            |
| Auto-record cancellation                                      | `gpt-5-mini`     | `gpt-5.6-luna`  | Chat Completions; JSON `{cancel, reason}`; invalid or failed output keeps the meeting                                       | Explicit `low`; low-cost classifier with a safe false fallback                       |
| Fast/slow transcript coalescing and final-pass reconciliation | `gpt-5-mini`     | `gpt-5.6-luna`  | Chat Completions; coalesced text or prompt-defined reconciliation JSON consumed by existing parsers                         | Explicit `low`; high-volume transcription-adjacent extraction                        |
| Meeting image captions                                        | `gpt-4o-mini`    | `gpt-5.6-luna`  | Chat Completions with low-detail image input; JSON `{caption, visibleText}`; failures skip the image                        | Temperature `0`, reasoning `none`; bounded, cost-sensitive vision-to-text extraction |

The following specialized models remain intentionally unchanged:

- `gpt-4o-transcribe` uses `audio.transcriptions.create` with JSON output,
  log probabilities, prompt/no-prompt voting, and the finalized-audio pass.
- `gpt-4o-mini-tts` uses `audio.speech.create` with PCM output. Its model,
  voice, queue, playback, and recording behavior are unchanged.
- `dall-e-3` uses `images.generate`; only the upstream text prompt model moves.
- No Realtime API, Responses API, embeddings, Batch API, or OpenAI tool-calling
  path exists in the current repository.

Legacy GPT-5.2, GPT-5 mini/nano, and GPT-4o mini choices remain in the model
registry as explicit rollback targets. Historical test fixtures that exercise
those compatibility paths are also retained.

## Compatibility decisions

- **Endpoint:** GPT-5.6 Sol, Terra, and Luna support Chat Completions, structured
  outputs, and image input. Chronote's calls are one-shot and tool-free, so an
  endpoint migration would add parser and continuation risk without being
  required for this model change.
- **Reasoning:** GPT-5.6 defaults to `medium` when omitted. The model capability
  resolver therefore explicitly emits `none` for every temperature-driven
  request and preserves `low` for the existing reasoning-driven classifiers.
  `max` is recognized for configured experiments but is not a default.
- **Structured output:** Existing `json_object` requests and their validation,
  parse, and fail-closed behavior remain unchanged. No schema was weakened.
- **Tools:** No migrated Chat Completions request supplies function tools, so
  the GPT-5.6 Chat Completions tools/reasoning compatibility gate is not hit.
- **Vision:** Image captions retain `detail: "low"`, avoiding GPT-5.6's changed
  `auto`/original-detail token behavior.
- **Prompt caching:** Chronote has a Langfuse prompt-fetch cache, but no OpenAI
  `prompt_cache_*` request fields or cache-key accounting. Prompt order and
  content are unchanged; explicit GPT-5.6 caching is deferred until measured.
- **Langfuse connection:** The checked-in OpenAI connection enables provider
  default models, so GPT-5.6 does not need a custom-model entry or a live
  Langfuse connection mutation for this code migration.
- **Persisted reasoning:** Chat Completions calls do not use
  `previous_response_id` or reasoning-item replay. Persisted reasoning, Pro
  mode, Programmatic Tool Calling, and multi-agent mode are not enabled.
- **Safety identifiers:** The installed OpenAI SDK exposes
  `safety_identifier` on Chat Completions. The shared notes/chat path already
  sent the meeting creator's raw Discord ID through the deprecated `user`
  field; it now sends a namespaced HMAC-SHA-256 pseudonym keyed by Chronote's
  session secret instead. Calls that previously had no OpenAI user identifier
  remain untagged, and offline evals omit the field.
- **Long context:** The family supports Chronote's current prompt sizes, but
  production rollout must still measure actual input tokens and flag requests
  approaching the current long-context pricing threshold.

No prompts were rewritten. The existing prompts already encode the product's
format, mention, permission, and completion boundaries, and no measured
GPT-5.6-specific prompt regression is available yet.

## Rollout and rollback plan

1. Capture a baseline from representative production-like traces for every
   role: parser success, empty/refusal rate, task success, first-token and total
   latency, timeout rate, input/output/reasoning/cached tokens, and cost per
   successful task. Sanitize user content in any exported comparison set.
2. Before any production code deployment, read the effective ECS environment
   and AppConfig values. Production model overrides are currently unknown.
   Configure explicit legacy values for every `models.<role>` key, especially
   `transcriptionCoalesce` and `imageCaption`, so deploying the code alone is a
   no-op for model routing.
3. Deploy and test in the isolated sandbox only after explicit authorization.
   Verify account access and rate limits for all three exact model IDs. Run the
   meeting-notes, meeting-summary, transcription, correction, gate, responder,
   Q&A, and image-caption cases against the same inputs.
4. Compare the preserved effort first. For `low` Luna classifiers, also test
   `none`; for `none` Sol/Terra routes, test `low` only where reasoning could
   improve the task. Do not promote a lower effort unless contract success and
   quality remain acceptable.
5. Roll production roles independently through AppConfig: Luna classifiers and
   coalescing first, Terra interactive text next, then Sol notes/corrections.
   Hold each stage long enough to compare success, latency, and cost with its
   baseline. Image captions have their own new model-choice key and can roll
   back independently.
6. Roll back a role by restoring its preserved legacy model choice. A broad
   fallback remains available through `NOTES_MODEL`,
   `LIVE_VOICE_GATE_MODEL`, and `LIVE_VOICE_RESPONDER_MODEL`, but per-role
   AppConfig rollback is safer and does not disturb unrelated workloads.
7. If Terraform-managed environment defaults are adopted, use a reviewed plan
   and manual apply. A later backend deploy is still required to move ECS to
   the new task-definition revision. Neither action is part of this change.

## Production verification gates

- Exact deployed commit and ECS task-definition revision are known.
- Effective model and reasoning effort are visible in Langfuse for every role.
- Notes and corrections preserve mention sanitization and Markdown contracts.
- Meeting summaries, gates, cancellation, reconciliation, and image captions
  maintain valid JSON and their existing safe fallback behavior.
- Q&A citations still resolve only from meetings the caller may access.
- Transcription, finalized-audio verification, TTS PCM playback, and DALL-E
  generation still use their unchanged model/provider paths.
- Cost, latency, token, timeout, refusal, and empty-output deltas are within the
  agreed threshold for each workload rather than only in aggregate.
- Rollback overrides have been read back and tested before the final rollout.

Live API evals, account model availability, current production overrides, and
production cost/latency deltas remain unknown until an authorized sandbox or
production-like run is performed.
