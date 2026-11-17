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

Production meetings showed these layers hurting transcripts:

- The prompt was echoed back on short noise, and the echo gate cannot catch
  short echoes. Most of the remaining machinery existed only to contain that.
- Coalesce occasionally discarded whole passages.
- The finalized-audio pass was discarded by its own guardrail in 38% of real
  runs after minutes of delay, and made kept transcripts worse.
- The forced language hint broke non-English meetings once the prompt was
  removed.
- The pre-ASR noise gate, speech admission and post-ASR guards were correct
  and necessary: raw ASR hallucinated on every non-speech case without them.

## Decision

1. Live snippet ASR sends one request per snippet to `models.transcription`
   with no prompt. `gpt-transcribe` is the only selectable model; a stored
   `gpt-4o-transcribe` or `gpt-4o-mini-transcribe` choice resolves to it with
   one warning instead of invalidating the config.
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
   admission every admitted snippet carries them. A keyword rejection
   (HTTP 400 `invalid_value` with no `param`) is retried once without them,
   inside the request's four attempts, so a bad term costs dictionary
   spelling, not the snippet. A per-model capability
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
   with the frozen model and language (a frozen retired model runs on
   `gpt-transcribe`; the saved settings keep it), no prompt, and keywords rebuilt from
   the saved dictionary entries and saved budget, so the keywords themselves
   are not frozen. Stored config values for removed keys are ignored.

## Consequences

### Production replay

Every qualifying production meeting from 2026-11-01 to 2026-11-16 with stored
per-speaker audio and at least 2 minutes of speech: 53 meetings, 24 servers,
211 speaker tracks, about 2,170 speaker-minutes. Each meeting's snippets were
rebuilt exactly as production cut them and replayed through this change's
slow-pass path (speech detector enforced, `gpt-transcribe`, the server's
dictionary as keywords, its language setting, the guards), then compared with
the transcript production stored. References are machine drafts from two
local Whisper models, not human checked; headline numbers use only regions
where both agree.

| stored production vs new pipeline           | stored  | new    |
| ------------------------------------------- | ------- | ------ |
| WER (38 word-scored meetings, 151k words)   | 0.280   | 0.149  |
| CER (15 character-scored meetings, 62k ch.) | 0.273   | 0.167  |
| Share of reference words present            | 0.75    | 0.90   |
| Reference words dropped                     | 4,597   | 542    |
| Non-speech hallucinated lines, word-scored  | 407     | 34     |
| Non-speech hallucinated lines, char-scored  | 133     | 42     |
| Echoed glossary or label lines              | 468     | 2      |
| Requests for the 53 meetings                | ~39,200 | 14,573 |

The old request count is 34,935 live ASR (including 2,668 vote second calls),
3,656 coalesce, 324 final-pass audio and 332 judge calls; the replay does not
model the fast pass, retries or live timing. Of the 10 largest per-meeting
regressions inspected, 3 were real, 6 were reference or scoring errors and 1
a replay artefact.

On the public corpus (25 cases, exact LibriSpeech and FLEURS references) WER
was 0.071 for the former path, 0.036 for `gpt-transcribe` and 0.052 for
`gpt-4o-mini-transcribe`. An earlier 39-case private snippet set pointed the
same way and is superseded by the replay. A 349 s personal upload scored WER
0.024 to 0.026 with no truncation.

Positive:

- Lower error, far fewer dropped words, hallucinated and echoed lines, and
  about a third of the requests. Short English clips (1 to 3 s) with auto
  language produced 0 of 90 non-English outputs.
- Cost per request drops from $0.006 to $0.0045 per audio minute.
- Several thousand lines of production code and tests are gone.

Negative:

- More one- or two-word lines in the wrong language in non-English meetings
  under auto-detect (66 to 135 in word-scored meetings, 19 to 65 in
  character-scored), and no clear win on two very small character-language
  slices (3 meetings).
- Auto detection misreads very short non-English speech. On short Japanese
  clips, `gpt-transcribe` with auto language returned another language on 7
  of 387 natural-speech runs (1.8%; 3 of 129 clips, all 0.89 s or shorter)
  and had higher CER (0.15 against 0.11 on public FLEURS cuts, 0.19 against
  0.13 on private clips) than with `language: "ja"`, which had no
  wrong-language runs. Servers that mostly speak one language other than
  English should pin it.

- Rolling the model back is no longer a setting; rollback means reverting
  this change. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` reject
  `keywords` and shut down on 2027-02-26, so neither stays selectable.
- Keywords in a language other than the speech can cost accuracy: the public
  Japanese clip sent with the English public dictionary was exact in 3 of 8
  runs, against 8 of 8 without keywords.
- A worker on the previous version finishing a recording made by this version
  on a server with a pinned language sends the singular `language` to
  `gpt-transcribe`; a live call on 2026-11-16 confirmed the API accepts it.
- The three remote Langfuse prompts remain until retired by hand.

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
- Noise, detection enforced: on 12 real non-speech snippets (36 runs) with
  the server's 4 terms padded to 20, the guards passed 6 keyword-only
  outputs; withholding keywords from the snippet assessed `uncertain` removed
  3 at no term-recall cost, so 3 of 36 remain (6 of 36 with detection `off`).
  With the server's own 4 terms only, the 36 runs returned no text (0 of 36).
  A guard on keyword-only output would blank genuine speech made only of
  dictionary terms (984 of 29,698 stored segments in the four servers with a
  dictionary are exactly one term), so none is used.

### Model defaults

Default text models moved off the 5 series: meeting summary, notes
correction, transcription cleanup and image prompt from `gpt-5.2` to
`gpt-6.1-sol` (low reasoning, no temperature); dictionary teaching, the live
voice gate and auto-record cancellation from `gpt-5-mini` to `gpt-6.1-terra`
(dictionary teaching at temperature 0 with reasoning `none`, the others at
low reasoning). The 5-series models stay selectable, and frozen recording
snapshots keep their model and parameters. The meeting summary eval scored
the same on both defaults; the other roles had a smoke check (3 synthetic
calls per model for request acceptance and parsing), not a quality
evaluation. Production sets `LIVE_VOICE_GATE_MODEL` through Terraform, so the
gate and auto-record cancellation keep `gpt-5-mini` until that variable
changes.

## Alternatives Considered

- Keep the final pass with a stronger judge: re-run with `gpt-6.1-sol` and
  `gpt-6.1-terra` as judge on 34 replay meetings. On the new pipeline it made
  14 to 16 meetings worse and at most 1 better (WER 0.162 to 0.252 with sol,
  0.241 with terra), and on the old pipeline's pre-final-pass text it was
  also worse than its input. Harmful as an idea on this data.
- Keep coalesce with a stronger model: on 800 production calls, error was
  0.190 for slow text alone, 0.213 for production's small model (36 calls
  destroyed more than half the text), 0.170 and 0.177 with `gpt-6.1-terra`
  and `gpt-6.1-sol` (not significant; 14 destroyed calls each). On the new
  ASR with new-model fast revisions (569 calls): 0.1436 for slow text alone
  against 0.1453 with either model (+0.17 points, 95% CI -0.22 to +0.57 for
  terra; +0.16, -0.04 to +0.40 for sol), 0 destroyed calls, about half of
  outputs identical to the slow text, at $0.08 to $0.15 and 2 to 5 s per line
  extra per 45-minute meeting. No measurable gain.
- Keep the echo gate and vote: they policed the removed prompt; without them
  the replay's echo lines fell from 468 to 2 and non-speech hallucinated lines
  from 407 to 34.
- Keep `gpt-4o-transcribe` and only remove the prompt: more nonspeech
  hallucination, because the vote and echo gate were what blanked it.
- No dictionary in ASR, relying on notes to repair spelling: notes repaired
  almost every misspelling, but the stored transcript kept it, and synthetic term recall was 0.36.
- Remove the language setting: auto detection is worse for servers that
  speak one non-English language (short Japanese result above).
- Flag the stages off instead of deleting them: leaves untested code paths
  and settings that can be turned back on without measurement.

## Notes

- Eval details and commands: `docs/transcription-eval.md`.
- Pipeline description: `docs/audio-transcription.md`.
- After deploy, audit stored `transcription.language` and
  `models.transcription` values in server overrides and global AppConfig: a
  stored `en` keeps forcing English.
