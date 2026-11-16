# ADR-20261116: Transcription Simplification

Status: Accepted  
Date: 2026-11-16  
Owners: Audio pipeline

## Context

Live Discord snippets went through several layers on top of ASR:
`gpt-4o-transcribe` with a glossary prompt (server name, attendees, bot names,
dictionary terms, meeting context) and a forced language hint, a prompt echo
gate, a prompt/no-prompt vote that made a second ASR call on low-confidence
slow snippets, an optional per-snippet LLM coalesce of fast and slow text, and
a finalized-audio pass that re-transcribed the mixed recording and let an LLM
replace or drop segments.

Measurements on production meetings and an offline eval showed these layers
hurting transcripts:

- The prompt was echoed back on short noise, and the echo gate cannot catch
  short echoes. Most of the remaining machinery existed only to contain that.
- Coalesce occasionally discarded whole passages: slow-only WER 0.119 against
  0.220 for the stored coalesced output on one meeting.
- The finalized-audio pass was discarded by its own guardrail in 38% of real
  runs after minutes of delay, and made kept transcripts worse (error rate
  0.341 to 0.473 and 0.339 to 0.415 on two meetings).
- The forced language hint broke non-English meetings once the prompt was
  removed (Japanese CER 0.87).
- The pre-ASR noise gate, speech admission and post-ASR guards were correct
  and necessary: raw ASR hallucinated on every non-speech case without them.

## Decision

1. Live snippet ASR sends one request per snippet to `models.transcription`
   with no prompt and no language hint. The default model is `gpt-transcribe`
   (options `gpt-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`).
   Requests keep `temperature: 0`, JSON output and logprobs for the guards.
2. Delete the prompt echo gate, the vote and its second call, the ASR prompt
   and its Langfuse prompt, coalesce, the finalized-audio pass and its repeat
   filter, the `transcription.language` setting and the dictionary
   transcription budget. Delete, not flag off.
3. Keep the noise gate, speech admission, the quiet-audio logprob, hard
   silence, syllable rate and punctuation-only guards, retries and the
   breaker, fast and slow passes, cleanup and notes.
4. A settled slow result, including an empty one a guard suppressed, is
   authoritative. Fast text no longer resurfaces for that snippet, so the
   notes input, `transcript.json` segments and the live timeline agree. Fast
   reuse stays because a reused fast result passed the same guards on the same
   bytes.
5. Saved recordings keep parsing: removed settings, prompts and processing
   fields are accepted and ignored. Recovery re-transcribes uncovered audio
   with the frozen model and no prompt. Stored config values for removed keys
   are ignored.

## Consequences

Measured with two runs per case, slow pass, speech detector enforced.
Baseline A is the former path. Private references are local faster-whisper
`large-v3` and `large-v3-turbo` drafts, not human checked; public references
are exact LibriSpeech and FLEURS text.

| set                            | A         | `gpt-transcribe` | `gpt-4o-mini-transcribe` |
| ------------------------------ | --------- | ---------------- | ------------------------ |
| Public, 25 cases, WER          | 0.071     | 0.036            | 0.052                    |
| Private English meeting 1, WER | 0.144     | 0.073            | 0.077                    |
| Private English meeting 2, WER | 0.105     | 0.068            | 0.090                    |
| Private Japanese meeting, CER  | 0.109     | 0.106            | 0.106                    |
| Nonspeech hallucination rate   | 0 to 0.67 | 0                | 0                        |
| Empty output on speech         | 0         | 0                | 0                        |

Positive:

- Lower error on every measured set, zero nonspeech hallucination with the
  surviving guards, and non-English meetings are no longer forced into
  English. Short English clips (1 to 3 s) with auto language produced 0 of 90
  non-English outputs for `gpt-transcribe` and `gpt-4o-mini-transcribe`.
- Cost per request drops from $0.006 to $0.0045 per audio minute at list
  price, with no second vote call, no coalesce call and no re-transcription of
  the whole recording at meeting end. Notes are generated sooner.
- Several thousand lines of production code and tests are gone.

Negative:

- Term recall on the public corpus drops from 1.00 to about 0.55 because the
  glossary is no longer sent. The dictionary now reaches notes and cleanup
  only.
- Rollback to `gpt-4o-transcribe` is one setting, `models.transcription`, but
  that model without a language hint returned another language on 4 of 33
  short private English clips (12%).
- Remote Langfuse prompts `chronote-transcription-prompt`,
  `chronote-transcription-coalesce-chat` and
  `chronote-transcription-final-pass-chat` remain until retired by hand.

## Alternatives Considered

- Keep `gpt-4o-transcribe` and only remove the prompt: worse WER and more
  nonspeech hallucination, because the vote and echo gate were what blanked
  hallucinations.
- Send dictionary terms only as the prompt: replaced real one or two word
  utterances with a glossary term in 4 of 12 short runs.
- Keep a language setting: not needed given the 0 of 90 result.
- Flag the stages off instead of deleting them: leaves untested code paths
  and settings that can be turned back on without measurement.

## Notes

- Eval details and commands: `docs/transcription-eval.md`.
- Pipeline description: `docs/audio-transcription.md`.
