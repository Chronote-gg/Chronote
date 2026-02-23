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
- Vote fallback runs a no-prompt retry for low-confidence slow snippets and picks the better result with a deterministic arbiter (suppression flags, prompt echo, logprobs, and repetition checks).

## Langfuse audio attachments

When Langfuse tracing is enabled, each transcription snippet uploads an audio attachment to the trace for debugging.

- The attachment is always an MP3 generated from the snippet WAV file.
- Encoding is VBR quality 6, mono, 16 kHz to keep size down while staying intelligible.
- Attachments are skipped if the MP3 exceeds 8 MB.
- The MP3 file is temporary and is deleted after upload.
- The compressed MP3 is for observability only and does not affect transcription quality.

## Langfuse usage and cost

Transcription traces report duration-based usage so Langfuse can calculate costs without audio token math.

- Usage details include `input_audio_seconds`, rounded to three decimals.
- Configure Langfuse model pricing to charge per second using `input_audio_seconds`.
- We do not derive audio token counts for transcription, we keep it duration-based.

Pricing checklist:

- Add custom model definitions for `gpt-4o-transcribe` and `gpt-4o-transcribe-diarize` in Langfuse.
- Set pricing to use the `input_audio_seconds` usage key with a per-second rate.
- Set output token pricing to 0 if the model does not bill output tokens.

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

## Cleanup behavior

Transcription cleanup runs on the compiled transcript text. The structured transcript JSON stores per snippet text without cleanup. This keeps cleanup optional and limits the risk of rewriting per speaker segments during the capture phase.
