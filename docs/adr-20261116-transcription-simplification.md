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
   with no prompt. The default model is `gpt-transcribe`
   (options `gpt-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`).
   Requests keep `temperature: 0`, JSON output and logprobs for the guards.
   The per-server `transcription.language` setting stays, with its default
   changed from `en` to `auto`: auto sends no language hint, and a pinned
   language is sent as an ISO-639-1 code: `languages: [code]` for
   `gpt-transcribe`, `language` for the older models. Stored overrides keep
   working.
2. Server dictionary terms reach ASR through the model's dedicated
   `keywords` parameter, never the prompt: terms only, chosen by the existing
   dictionary ordering (newest first) and the restored
   `dictionary.maxChars.transcription` budget, at most 20 per request, and
   skipped when they contain `<` or `>` (terms are whitespace-normalized
   first). They go out on fast and slow passes unless speech detection in
   `enforce` mode assessed the snippet `uncertain` or was unavailable and
   admitted it anyway; with detection `off`, in `shadow` or on forced
   admission every admitted snippet carries them. A request whose keywords
   the provider rejects with HTTP 400 is retried once without them, so a bad
   term costs dictionary spelling, not the snippet. A per-model capability
   table decides the keyword and language fields; an unknown
   model throws.
3. Delete the prompt echo gate, the vote and its second call, the ASR prompt
   and its Langfuse prompt, coalesce, and the finalized-audio pass and its
   repeat filter. Delete, not flag off.
4. Keep the noise gate, speech admission, the quiet-audio logprob, hard
   silence, syllable rate and punctuation-only guards, retries and the
   breaker, fast and slow passes, cleanup and notes.
5. A settled slow result, including an empty one a guard suppressed, is
   authoritative. Fast text no longer resurfaces for that snippet, so the
   notes input, `transcript.json` segments and the live timeline agree. Fast
   reuse stays because a reused fast result passed the same guards on the same
   bytes.
6. Saved recordings keep parsing: removed settings, prompts and processing
   fields are accepted and ignored. Recovery re-transcribes uncovered audio
   with the frozen model and language, no prompt, and keywords rebuilt from
   the saved dictionary entries and saved budget, so the keywords themselves
   are not frozen. Stored config values for removed keys are ignored.

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
  English by default. Short English clips (1 to 3 s) with auto language
  produced 0 of 90 non-English outputs for `gpt-transcribe` and
  `gpt-4o-mini-transcribe`.
- Cost per request drops from $0.006 to $0.0045 per audio minute at list
  price, with no second vote call, no coalesce call and no re-transcription of
  the whole recording at meeting end. Notes are generated sooner.
- Several thousand lines of production code and tests are gone.

Negative:

- Auto detection misreads very short non-English speech. On short Japanese
  clips, `gpt-transcribe` with auto language returned another language on 7
  of 387 natural-speech runs (1.8%; 3 of 129 clips, all 0.89 s or shorter)
  and had higher CER (0.15 against 0.11 on public FLEURS cuts, 0.19 against
  0.13 on private clips) than with `language: "ja"`, which had no
  wrong-language runs. Servers that mostly speak one language other than
  English should pin it.

- Rollback to `gpt-4o-transcribe` is one setting, `models.transcription`, but
  that model without a language hint returned another language on 4 of 33
  short private English clips (12%). It and `gpt-4o-mini-transcribe` reject
  `keywords` with HTTP 400, so a rollback also loses dictionary spelling, and
  both are deprecated with shutdown on 2027-02-26. It is a weaker rollback
  than it looks.
- Keywords in a language other than the speech can cost accuracy: the public
  Japanese clip sent with the English public dictionary was exact in 3 of 8
  runs, against 8 of 8 without keywords.
- A worker on the previous version finishing a recording made by this version
  on a server with a pinned language sends the singular `language` to
  `gpt-transcribe`; a live call on 2026-11-16 confirmed the API accepts it.
- Remote Langfuse prompts `chronote-transcription-prompt`,
  `chronote-transcription-coalesce-chat` and
  `chronote-transcription-final-pass-chat` remain until retired by hand.

### Dictionary keywords

Measured with `gpt-transcribe`, temperature 0, three runs per clip, every raw
output replayed through the production gates and guards. Synthetic clips are
made-up terms read by TTS; real clips are cuts of production meetings whose
stored transcript has the term and an unprompted local model hears it.

| term recall, exact spelling  | no hint | `keywords`, 20 terms | `keywords`, 100 terms |
| ---------------------------- | ------- | -------------------- | --------------------- |
| Synthetic esoteric (201)     | 73      | 198                  | 145                   |
| Public glossary (30)         | 18      | 28                   | 21                    |
| Real production clips (129)  | 103     | 126                  | 114                   |
| Non-English given names (54) | 6       | 54                   | not separated         |

- No false insertions on term-free sentences or short real words at either
  size, and no latency cost. At 100 terms recall falls and sound-alike
  distractors replace the spoken term (15 of 120 synthetic runs); at 20 none
  did. Production dictionaries hold 1 to 5 terms, so the cap of 20 binds only
  large dictionaries and keeps them where the measurement showed no harm.
- A comma list of terms in `prompt` was worse on every set and echoed the
  whole list on noise; it is not used.
- Noise, measured with speech detection enforced: on 12 real non-speech
  snippets from one meeting (36 runs) whose 20-keyword list was the server's
  4 terms plus 16 distractors, the guards passed 6 keyword-only outputs:
  three lone keywords on a snippet assessed `uncertain`, two lone keywords
  and one whole-list dump on a snippet assessed `speech`. Withholding
  keywords from the `uncertain` snippet removed the first three and cost no
  term recall on the synthetic, public or real term clips, which were all
  assessed `speech`. Three keyword-only outputs remain (3 of 36 runs). A
  guard blanking outputs made only of three or more keywords removed one more
  run, but it would also blank genuine speech made only of dictionary terms,
  so it is not used. Suppressing a lone keyword would have removed the rest,
  but 984 of 29,698 stored segments in the four servers with a
  dictionary are exactly one term; the former prompt inserted terms, so how
  many were spoken is unknown, and every spoken one would be lost. With
  detection `off`, keywords go out on every admitted snippet, so the
  unmitigated figure applies: 6 of 36 keyword-only outputs. With the server's own 4 terms only, the same 36 runs returned no
  text at all, before any guard (0 of 36).

## Alternatives Considered

- Keep `gpt-4o-transcribe` and only remove the prompt: worse WER and more
  nonspeech hallucination, because the vote and echo gate were what blanked
  hallucinations.
- Send dictionary terms only as the prompt: replaced real one or two word
  utterances with a glossary term in 4 of 12 short runs, and as a comma list
  it was the weakest hint on `gpt-transcribe`.
- No dictionary in ASR, relying on notes to repair spelling: notes repaired
  almost every misspelling, but the stored transcript (portal, MCP, search,
  Notion export) kept it, and synthetic term recall was 0.36.
- Also suppress a single keyword alone: removes the last measured echoes but
  drops a person saying one name on its own.
- Rebuild the prompt echo gate or the vote for keywords: withholding keywords
  from uncertain snippets removed most measured echoes without a second
  request.
- Remove the language setting: the 0 of 90 English result supported it, but
  the short Japanese result above showed auto detection is worse for servers
  that speak one non-English language.
- Keep the `en` default: forces non-English meetings into English on servers
  that never set the language.
- Flag the stages off instead of deleting them: leaves untested code paths
  and settings that can be turned back on without measurement.

## Notes

- Eval details and commands: `docs/transcription-eval.md`.
- Pipeline description: `docs/audio-transcription.md`.
