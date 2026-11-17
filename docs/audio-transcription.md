# Audio Transcription Flow

## Overview

Chronote records voice audio, builds per speaker snippets, and runs transcription in two passes. A fast pass gives early results during short pauses, while the slow pass finalizes a snippet after longer silence or a max snippet wall. The system keeps longer contiguous snippets to preserve accuracy. Each snippet is one ASR request with no prompt, the server dictionary terms as keyword hints unless enforced speech detection judged the snippet uncertain or was unavailable, and a language hint only when the server pins one, followed by deterministic guards. The slow pass text is the transcript text; no language model rewrites individual snippets. See [ADR-20261116](adr-20261116-transcription-simplification.md).

## Product decisions

- Dual pass transcription: Fast transcriptions are for timely feedback. Slow transcriptions are the authoritative final output.
- Minimum snippet size: Short snippets are skipped to avoid sending noise or partial audio to transcription.
- Max snippet wall: A snippet is forced to finalize when it grows too long, even if a speaker never fully pauses.
- Interjection ordering: Optional interjection splitting finalizes paused snippets when another speaker interjects, so ordering is closer to the actual conversation.

## Technical decisions

- Snippets are per speaker and store raw PCM chunks, a start timestamp, and recent fast transcript metadata.
- Fast transcription is triggered after the fast silence threshold and only when snippet duration exceeds the minimum snippet seconds.
- Slow transcription finalizes after the slow silence threshold or after the max snippet wall.
- Fast only finalization can skip the slow pass if the latest fast transcript covers the full snippet byte length. That fast result already passed the same guards on the same bytes.
- A settled slow result is authoritative, including an empty one a guard suppressed. An earlier fast result never resurfaces for that snippet, so the compiled notes input, `transcript.json` segments and the live timeline agree.
- Interjection splitting checks for a validated interjection snippet before finalizing other paused snippets.
- Noise gate checks peak levels in short windows and skips snippets that are very quiet and lack speech-like peaks.
- The ASR model is `models.transcription` (only option `gpt-transcribe`; a stored retired `gpt-4o-transcribe` or `gpt-4o-mini-transcribe` resolves to it with one warning). Personal uploads use the same key. Requests send `temperature: 0`, `response_format: "json"` and `include: ["logprobs"]`, with no `prompt`, so the provider has no glossary text to echo back. Personal uploads send no keywords and no language hint.
- What each model accepts comes from the capability table in `services/transcriptionRequest.ts`, never from guessing: `gpt-transcribe` takes `keywords` and a `languages` list (the API refuses `language` and `languages` together), while `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` reject both `keywords` and `languages` with HTTP 400 and take the singular `language`. An unknown model id throws.
- Dictionary terms steer recognition as `keywords`: terms only, no definitions, chosen by `buildDictionaryPromptLines` (newest `updatedAt` first, then alphabetical) within `dictionary.maxEntries` and `dictionary.maxChars.transcription`, capped at 20 per request (`TRANSCRIPTION_KEYWORD_LIMIT`). Terms are whitespace-normalized, and a term containing `<` or `>` is skipped, because one such keyword makes the API reject the whole request. Fast and slow passes both send them. Definitions feed notes, cleanup, ask and other text prompts.
- Keywords are sent when speech detection assessed the snippet as `speech` or enforced no decision (`off`, `shadow`, forced admission). They are withheld only when `enforce` mode ran and assessed the snippet `uncertain` or the detector was unavailable and the snippet was admitted anyway, because uncertain noise sent with keywords came back as a lone keyword. With detection off every admitted snippet carries them.
- Guardrails include a loudness gate (noise gate metrics plus token logprobs), hard silence suppression, a syllable rate gate for short snippets, and suppression of punctuation-only output.

## Snippet ASR retries

Each snippet request owns at most four ASR attempts, including
the first. Only connection failures, timeouts and HTTP 408, 409, 429 or 5xx
responses can retry. Cancellation, local input failures, other 4xx responses,
quota exhaustion and an explicit `x-should-retry: false` are terminal.
A keyword rejection (HTTP 400 `invalid_value` with no `param`) is retried
once without keywords, as one of the four attempts, with a warning and
`chronote_transcription_keywords_rejected_total`. Other 400s stay terminal.
Guards and attachment failures do not retry ASR.

Each attempt opens and closes a fresh upload stream and disables SDK retries
for that snippet request.

Retries use Cockatiel's decorrelated exponential backoff, starting at 128 ms
with exponent 2 and a 30,000 ms cap. Valid Retry-After values from 0 through
60,000 ms take precedence. Cancellation interrupts backoff and prevents new
dispatches; issued requests and streams still settle before cleanup.

The shared bulkhead holds two complete logical transcriptions with up to
100 queued jobs. Logical starts remain spaced by 800 ms. The breaker counts
five exhausted transient ASR operations before opening for 10,000 ms;
unrelated guard errors cannot trip it. Text Responses and personal upload
retry policies are separate.

## Personal upload transcription

Personal uploads and desktop recordings send no `language` hint, so the
provider detects the spoken language. A forced English hint badly truncated
non-English recordings.

Live meeting snippets take their hint from the `transcription.language`
setting (global superadmin and server admin scopes, default `auto`). `auto`
omits the language hint so the provider detects the language; any other
value is sent as an ISO-639-1 code, as `languages: [code]` to `gpt-transcribe`
and as `language` to the older models. Pinning is recommended for servers that
mostly speak one language other than English: on short Japanese clips, auto
detection returned another language on 1.8% of runs, all on clips under one
second, while a pinned `ja` returned none. The value is captured in the
meeting runtime config when the meeting starts, frozen into the saved
recording settings, and reused by recovery. Records saved before the setting
existed parse as `en`, which is what they were transcribed with.

Normalized audio is always split into
`PERSONAL_UPLOAD_TRANSCRIPTION_CHUNK_SECONDS` (300 s) chunks before
transcription, regardless of file size. The transcription model caps output
near 2,000 tokens per request, so a whole file under the 25 MB request limit
(about 55 minutes at the 64 kbps normalization bitrate) used to come back
silently truncated.

## Langfuse audio attachments

When Langfuse tracing is enabled, each transcription snippet uploads an audio attachment to the trace for debugging.

- The attachment is always an MP3 generated from the snippet WAV file.
- Encoding is VBR quality 6, mono, 16 kHz to keep size down while staying intelligible.
- Attachments are skipped if the MP3 exceeds 8 MB.
- The MP3 file is temporary and is deleted after its bytes are prepared for the attachment.
- The compressed MP3 is for observability only and does not affect transcription quality.

Attachment preparation and ASR run concurrently inside the same transcription
generation. The generation and snippet WAV remain owned until attachment work
and its trace update have settled, including when ASR fails. A cancellation
check after this drain prevents a late abort from publishing a successful
snippet. Queued attachment work skips encoding after cancellation; running
ffmpeg encoding still cannot be cancelled and must finish before cleanup.

## Langfuse usage and cost

Transcription traces report the usage OpenAI returns. The default
`gpt-transcribe` reports duration, recorded as the `input_audio_seconds` usage
key and priced per second. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`
report tokens, recorded as `input`, `output` and `total` and priced per token.

- Returned usage is retained even if a later guard or cancellation fails.
- Each trace records whether token accounting is `priced`, `partial`, or
  `unpriced`. A duration-only response counts as `unpriced` here even though
  its `input_audio_seconds` usage carries a per-second price.
  Existing request counts describe returned responses. A transient failure
  followed by one priced response has one returned request but partial cost.
- Attempt counters distinguish SDK invocations, actual fetch entries and
  extra invocations. A fetch entry is not proof of provider
  receipt or billing; a lost response has unknown usage.
- Attempt usage coverage is `not_attempted`, `complete`, `partial` or
  `unknown`. Valid duration usage is known but does not establish token
  pricing. Complete pricing requires priced usage for every dispatch.
- Snippet `input_audio_seconds` comes only from reported duration usage.
  `transcriptionEstimatedAttemptAudioSeconds` is a separate estimate when
  local audio duration is known. Missing responses never imply zero billing.
- `transcriptionQueueWaitMs` measures bulkhead and logical-start limiter wait.
  Aggregate accounting is attempted inside the existing generation on success,
  failure and cancellation, before attachment drainage. Diagnostic failures
  cannot replace the provider result.

Attempt metadata uses the `transcription` prefix for `SdkInvocationCount`, `HttpDispatchAttemptCount`,
`RetryCount`, `KnownUsageAttemptCount`, `UnknownUsageAttemptCount` and
`AttemptUsageCoverage`. These diagnostics add no content or identifiers.
Existing two-argument accounting callers retain their legacy operational
duration fallback; that fallback is not attributed token cost.

Pricing checklist:

- Match the deployed transcription model definition (default `gpt-transcribe`)
  against that exact model name. `gpt-transcribe` reports duration usage
  rather than tokens, so it needs a per-second price.
- For the token-reporting models, set `input` and `output` per-token prices to
  the current OpenAI rates.
- Keep the usage keys and model definition aligned; Langfuse price keys must
  exactly match the generation's usage-detail keys.
- Verify new production observations show usage (seconds or tokens) and
  non-null cost before treating cost coverage as complete.

## Config keys

All values are set via the config system. For the noise gate, only `enabled`, `applyToFast`, and `applyToSlow` support server overrides. The numeric thresholds remain global-only.

- `transcription.language`
- `transcription.fastSilenceMs`
- `transcription.slowSilenceMs`
- `transcription.minSnippetSeconds`
- `transcription.maxSnippetMs`
- `transcription.fastFinalization.enabled`
- `transcription.interjection.enabled`
- `transcription.interjection.minSpeakerSeconds`
- `transcription.suppression.enabled`
- `transcription.suppression.hardSilenceDbfs`
- `transcription.suppression.rateMaxSeconds`
- `transcription.suppression.minWords`
- `transcription.suppression.minSyllables`
- `transcription.suppression.maxSyllablesPerSecond`
- `transcription.noiseGate.enabled`
- `transcription.noiseGate.windowMs`
- `transcription.noiseGate.peakDbfs`
- `transcription.noiseGate.minActiveWindows`
- `transcription.noiseGate.minPeakAboveNoiseDb`
- `transcription.noiseGate.applyToFast`
- `transcription.noiseGate.applyToSlow`
- `models.transcription`
- `dictionary.maxChars.transcription` (with `.pro` and `.cap`), the character budget for keyword hints

Stored values for removed keys (`transcription.promptEcho.enabled`, `transcription.vote.enabled`,
`transcription.finalPass.enabled` and `models.transcriptionCoalesce`) are
ignored. Saved recordings that carry them still parse and recover; recovery
re-transcribes uncovered audio with the frozen model (a retired one runs on
`gpt-transcribe`, logged once) and language, no prompt,
and keywords rebuilt from the saved dictionary entries and saved
`dictionary.maxChars.transcription` budget when the frozen model accepts them.

## Interjection behavior

Interjection splitting is guarded to avoid fragmenting snippets on noise.

- Interjection splitting is disabled by default.
- The interjector must produce a snippet that meets `transcription.interjection.minSpeakerSeconds`.
- Only paused speakers are finalized. Active speakers are not split.
- Paused snippets are only finalized if their most recent pause began within `transcription.slowSilenceMs` of the interjection start.

## Noise gate behavior

The noise gate is a lightweight, peak-based check to skip clips that are very quiet.

- The gate splits audio into short windows and measures peak dBFS per window.
- A noise floor is estimated from low percentile windows, then windows above the noise floor plus the configured offset count as active.
- A snippet is skipped only when the overall peak stays below the configured threshold and there are too few active windows.
- Forced transcriptions, such as live voice commands, bypass the gate and quiet-audio suppression.
- Low-confidence transcripts from quiet audio are suppressed using token logprobs, even when a snippet makes it past the gate. Quiet audio uses avg or min logprob checks.
- Hard silence suppression drops snippets whose peak stays below `transcription.suppression.hardSilenceDbfs`, regardless of logprobs.
- Syllable rate suppression drops short snippets that exceed the configured syllables-per-second threshold once word and syllable minimums are met.
- Punctuation-only outputs are treated as trivial text and suppressed.

## Cleanup behavior

Transcription cleanup runs on the compiled transcript text. The structured transcript JSON stores per snippet text without cleanup. This keeps cleanup optional and limits the risk of rewriting per speaker segments during the capture phase.

During one normal finalization, the notes and upload compilations reuse a
settled cleanup result only when the existing retention rule accepts it and
the formatted transcript, rendered prompt and provenance, effective model,
parameters and retention ratio match. Nonempty cues, including whitespace,
change that request and require cleanup again. Failed or rejected cleanup
leaves the upload compilation its retry opportunity.

Reuse belongs to that finalization's compiler and is never persisted or
shared across meetings. Cancellation artifact compilation has a fresh
lifetime. Recovery independently uses its saved v1 prompt/settings and durable
processed-text checkpoints. Selected transcript membership is captured before
asynchronous cleanup, so files arriving later remain supplemental evidence.

## One-time speech-filter listening check

This is an operator command, not a customer feature or a scheduled job. It extracts a small private batch from explicitly selected completed meetings without calling ASR or replaying the detector. It changes neither enforcement nor production storage. Deploy the receipt-producing code before expecting new evidence; historical empty omissions are not rejection receipts.

1. Through the existing private operator tools, read only the selected meeting history rows and export their committed `checkpoint` pointers into a local, untracked JSON file. Do not include transcript bodies. Select at most three completed meetings. Each entry must explicitly bind the meeting ID:

   ```json
   [
     {
       "meetingId": "SELECTED_MEETING_ID",
       "checkpoint": { "...": "exact saved checkpoint pointer" }
     }
   ]
   ```

2. Build the source with `yarn build`. In an authorized operator environment with the existing AWS credential chain, run:

   ```sh
   node scripts/speech-detection/listening-batch.mjs --checkpoints selected.json --account EXPECTED_ACCOUNT_ID --region us-east-1 --bucket VERIFIED_RECORDING_BUCKET --out PRIVATE_NEW_DIRECTORY
   ```

   Refresh account, region, bucket and meeting identity through the intended private AWS tools first. The command checks STS account and S3 bucket owner. It only uses `GetCallerIdentity` and `GetObject`, never lists meetings, writes production data, or provisions credentials. Do not copy credentials into arguments. Output must be a fresh private directory outside the checkout. Paths inside the checkout, including `.cache/`, are rejected; symlinked parent directories are resolved before this check. On Windows, use a private user directory with appropriate existing ACLs.

3. Open the numbered WAVs with an ordinary local player. The command selects up to ten distinct rejected inputs, prioritizing final omissions and short clips, and up to three short retained transcript controls. Fast/slow decisions for identical inputs are grouped; overlapping inputs are kept distinct. Controls prove retained correspondence to a transcript, not a saved positive detector decision. They still need human listening. Selection is biased and cannot establish a production error rate.

   Every exact rejected clip is checked against its recorded input hash/length and the original saved PCM objects. The manifest distinguishes `request_skipped`, `final_omission`, and `transcript_present`. The last only means that the same snippet later had transcript text; it does not prove the rejected subinterval was transcribed. Optional `-context.wav` files include at most two seconds either side inside one verified contiguous piece. The manifest marks the exact tested interval within context; unavailable context does not invalidate the exact clip. No names or transcript text are exported.

4. Record brief speech / non-speech / unclear observations locally, tied to clip numbers. Report any speech found in a rejected clip for investigation. Human findings never automatically tune thresholds or change settings. Keep aggregate skipped requests separate from distinct audio inputs and billing.

5. Delete the temporary batch and local checkpoint selection after the check, retaining only minimized findings and necessary private references. Do not commit recordings, transcript bodies or the private manifest. Original recording retention/deletion rules still apply.

Exit 0 means a full batch awaits listening, not that quality passed. Exit 2 means incomplete coverage; inspect the private `manifest.json` gaps. Exit 1 means the command could not complete. Missing receipts, unavailable/deleted/corrupt PCM, identity mismatches and missing enforcement settings are explicit gaps. The script does not guess, substitute mixed recordings, or label a fresh model judgment as historical evidence. A stale pointer can outlive a history-row deletion, so operators must obtain fresh authorized pointers and honor deletion requests, never reuse cached selections to bypass access removal.

Local checks: `node --test scripts/speech-detection/listening-batch.test.mjs` after building, plus `test/services/recordingContentService.test.ts`.
