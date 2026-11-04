# Audio Transcription Flow

## Overview

Chronote records voice audio, builds per speaker snippets, and runs transcription in two passes. A fast pass gives early results during short pauses, while the slow pass finalizes a snippet after longer silence or a max snippet wall. The system keeps longer contiguous snippets to preserve accuracy, then uses optional coalescing to merge fast and slow outputs when premium is enabled. On low-confidence slow snippets, it can run a second no-prompt transcription and select the better candidate.

## Product decisions

- Dual pass transcription: Fast transcriptions are for timely feedback. Slow transcriptions are the authoritative final output.
- Minimum snippet size: Short snippets are skipped to avoid sending noise or partial audio to transcription.
- Max snippet wall: A snippet is forced to finalize when it grows too long, even if a speaker never fully pauses.
- Interjection ordering: Optional interjection splitting finalizes paused snippets when another speaker interjects, so ordering is closer to the actual conversation.

## Technical decisions

- Snippets are per speaker and store raw PCM chunks, a start timestamp, and recent fast transcript metadata.
- Fast transcription is triggered after the fast silence threshold and only when snippet duration exceeds the minimum snippet seconds.
- Slow transcription finalizes after the slow silence threshold or after the max snippet wall.
- Fast only finalization can skip the slow pass if the latest fast transcript covers the full snippet byte length.
- Interjection splitting checks for a validated interjection snippet before finalizing other paused snippets.
- Noise gate checks peak levels in short windows and skips snippets that are very quiet and lack speech-like peaks.
- Transcription prompt is Langfuse-managed (`chronote-transcription-prompt`) and can be adjusted for experiments, including removing the prompt entirely.
- Guardrails include a loudness gate (noise gate metrics plus token logprobs), a syllable rate gate for short snippets, and a prompt echo gate to suppress prompt repetition.
- Vote fallback runs a no-prompt candidate for low-confidence slow snippets and picks the better result with a deterministic arbiter (suppression flags, prompt echo, logprobs, repetition checks, and a hard reject for punctuation-only outputs like `.`).
- The finalized audio pass rejects trivial replacement text, so punctuation-only edits do not overwrite an existing snippet transcript.
- The finalized audio pass transcribes `TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS` (300 s) chunks. The transcription model caps output near 2,000 tokens per request, so the earlier 900 s chunks came back truncated on dense speech, and the reconcile prompt could drop the uncovered lines as "not in the chunk transcript".
- The finalized audio pass also drops repeated low-information snippets from the same speaker when they recur in a short window, which helps clean up bursts of greeting-style hallucinations.

## Snippet ASR retries

Each prompt or no-prompt candidate owns at most four ASR attempts, including
the first. Only connection failures, timeouts and HTTP 408, 409, 429 or 5xx
responses can retry. Cancellation, local input failures, other 4xx responses,
quota exhaustion and an explicit `x-should-retry: false` are terminal.
Prompt preparation, guards and attachment failures do not retry ASR.

Each attempt opens and closes a fresh upload stream and disables SDK retries
for that snippet request. A successful prompted candidate is retained when
the no-prompt vote retries. Both candidates exhausting their budgets permit
up to eight ASR attempts. This can change recovery opportunity and worst-case
work compared with a single whole-workflow budget; it does not guarantee
lower cost or latency on every path.

Retries use Cockatiel's decorrelated exponential backoff, starting at 128 ms
with exponent 2 and a 30,000 ms cap. Valid Retry-After values from 0 through
60,000 ms take precedence. Cancellation interrupts backoff and prevents new
dispatches; issued requests and streams still settle before cleanup.

The shared bulkhead holds two complete logical transcriptions with up to
100 queued jobs. Logical starts remain spaced by 800 ms. The breaker counts
five exhausted transient ASR operations before opening for 10,000 ms;
unrelated prompt or guard errors cannot trip it. Text Responses, finalized
audio verification and personal upload retry policies are unchanged.

## Personal upload transcription

Personal uploads and desktop recordings send no `language` hint, so the
provider detects the spoken language. A forced English hint badly truncated
non-English recordings.

Live meeting snippets and the finalized audio pass take their hint from the
`transcription.language` setting (global superadmin and server admin scopes,
default `en`). `auto` omits the `language` field so the provider detects the
language; any other value is sent as an ISO-639-1 code. The value is captured
in the meeting runtime config when the meeting starts, and both paths read
that one value, so the final-pass reconcile never compares transcripts in two
languages. It is frozen into the saved recording settings, and recovery reruns
reuse the saved value. Records saved before the setting existed parse as `en`.

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

Transcription traces report the exact token usage returned by OpenAI so
Langfuse can calculate costs using the provider's input and output rates.

- Usage details use Langfuse's `input`, `output`, and `total` keys.
- Returned usage is retained even if a later vote, guard or cancellation fails.
- Each trace records whether accounting is `priced`, `partial`, or `unpriced`.
  Existing request counts describe returned responses. A transient failure
  followed by one priced response has one returned request but partial cost.
- Attempt counters distinguish logical candidates, SDK invocations, actual
  fetch entries and extra invocations. A fetch entry is not proof of provider
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

Attempt metadata uses the `transcription` prefix for
`LogicalCandidateCount`, `SdkInvocationCount`, `HttpDispatchAttemptCount`,
`RetryCount`, `KnownUsageAttemptCount`, `UnknownUsageAttemptCount` and
`AttemptUsageCoverage`. These diagnostics add no content or identifiers.
Existing two-argument accounting callers retain their legacy operational
duration fallback; that fallback is not attributed token cost.

Pricing checklist:

- Match the deployed `gpt-4o-transcribe` model definition against that exact
  model name.
- Set `input` and `output` per-token prices to the current OpenAI rates.
- Keep the usage keys and model definition aligned; Langfuse price keys must
  exactly match the generation's usage-detail keys.
- Verify new production observations show both token usage and non-null cost
  before treating cost coverage as complete.

## Config keys

All values are set via the config system. For the noise gate, only `enabled`, `applyToFast`, and `applyToSlow` support server overrides. The numeric thresholds remain global-only.

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
- `transcription.promptEcho.enabled`
- `transcription.vote.enabled`
- `transcription.finalPass.enabled`
- `transcription.noiseGate.enabled`
- `transcription.noiseGate.windowMs`
- `transcription.noiseGate.peakDbfs`
- `transcription.noiseGate.minActiveWindows`
- `transcription.noiseGate.minPeakAboveNoiseDb`
- `transcription.noiseGate.applyToFast`
- `transcription.noiseGate.applyToSlow`

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
- Prompt echo suppression runs after transcription and is independent of the loudness gate.
- Punctuation-only outputs are treated as trivial text. The vote arbiter will not let a punctuation-only no-prompt retry beat a real prompt transcript, and the final pass will not apply punctuation-only replacements.
- After final-pass edits are applied, repeated low-information snippets from the same speaker are filtered when they recur within a short window and closely match an earlier kept phrase.

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
