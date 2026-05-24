# Hallucination mitigation plan 2026-02-13

Scope

- Source audit: meeting `3837e4e0-64e9-44ba-b5de-c3a6849832d6` (2052 traces).
- Goal: carry forward durable mitigation learnings without shipping large raw artifacts.

Evidence summary

- Classified outputs: hallucinated 379, legit 495, unknown 1178.
- Dominant hallucination mode is prompt echo (`300/379`).
- Secondary hallucination mode is recurring content pattern (`contains_vket`, `79/379`).
- Current short-clip syllable-rate gate appears safe for this sample.
  - For clips <=3 seconds with non-empty output, max legit SPS was 5.217.
  - No legit clips in that short-clip set exceeded the current threshold (7).
- Audio loudness separates classes strongly in this sample, but this analysis used mean dB from offline ffmpeg and should not be copied directly into runtime thresholds.

Config recommendations (immediate)

- Keep `transcription.promptEcho.enabled=true` as the default and primary protection.
- Keep current rate gate defaults for now.
  - `transcription.suppression.rateMaxSeconds=3`
  - `transcription.suppression.minWords=4`
  - `transcription.suppression.minSyllables=8`
  - `transcription.suppression.maxSyllablesPerSecond=7`
- Keep `transcription.suppression.hardSilenceDbfs=-60` until a broader multi-meeting validation run confirms a safer change.

Config improvements to add

- Add prompt-echo tuning keys so thresholds can be tuned without code edits.
  - `transcription.promptEcho.minChars` (default 12)
  - `transcription.promptEcho.minWords` (default 2)
  - `transcription.promptEcho.similarityThreshold` (default 0.2)
- Add optional server-level override controls for the above keys in config registry.

System improvements to add

- Add a vote transcription path for suspicious snippets.
  - Trigger only on guard failures/signals (prompt echo, low confidence, rate mismatch non-empty, high repetition).
  - Run at least two variants (for example prompt and no-prompt), then choose with an arbiter.
  - Arbiter should score anti-repetition, confidence/logprob, and plausibility, not just output length.
- Add a repetition-pattern guard signal (for example repeated token ratio or repeated n-gram ratio) to catch non-prompt hallucinations.
- Split metrics by reason and intent to avoid mixing behaviors.
  - Keep manual user dismissals separate from low-content auto-cancellations.

Evaluation loop

- Use `analysis/hallucination-audit/create_langfuse_dataset_sample.py` to create balanced labeled samples from classified traces.
- Run transcription evals with `src/evals/transcriptionEval.ts` using Langfuse datasets and experiment names.
- Track at least:
  - Prompt-like rate
  - Top stability
  - WER (where references exist)
  - Suppression reason distribution over time

Rollout strategy

- Phase 1: ship prompt-echo tunable config keys and dashboards (no behavior change by default).
- Phase 2: ship gated vote-transcription for suspicious snippets at low traffic percentage.
- Phase 3: evaluate and then tune hard-silence/noise thresholds only if metrics improve across multiple meetings.
