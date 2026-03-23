---
title: Audio and Transcription Reliability Plan
date: 2025-12-30
owner: chronote
---

## Goals

- Restore reliable audio capture, transcription, and live voice gating under packet loss and rapid VAD toggling.
- Produce a final composite audio artifact that sounds like the room, but never drops captured packets.
- Establish a repeatable eval harness for audio clips, including multi-run stochastic analysis.
- Reduce configuration drift by clarifying where defaults live and how tfvars, secrets, and env files map to runtime.

## Current configuration drift and defaults

These observations are based on `.env`, `.env.example`, `_infra/terraform.tfvars`, and `_infra/terraform.tfvars.example`.

- Defaults are duplicated across config files and `src/services/configService.ts`, so the same values are applied at multiple points.
- Live voice settings and model choices appear in all four sources, which makes it easy for local, staging, and prod to diverge.
- Some values appear more than once in `.env`, which makes the effective value order dependent.
- The Terraform tfvars file only wires non-secret env vars, while secrets are expected in AWS Secrets Manager. This is correct, but there is no consolidated mapping document.

Short term rule for this plan:

- Defaults should live in `src/services/configService.ts` only.
- Examples in `.env.example` and `terraform.tfvars.example` should show optional values but should not redefine defaults.
- Actual deployment values come from Terraform and Secrets Manager, not from `.env`.

Future direction, not part of Phase 0:

- Evaluate AWS AppConfig or SSM Parameter Store for a single authoritative config source for non-secrets, with Secrets Manager for secrets.
- Add a config map document that lists each setting, its source, and whether it is required.

## Phase 0: Live voice gate temperature guard

Objective:

- Stop GPT-5 family models from erroring on `temperature` in live voice gate and confirm flows.

Changes:

- In `src/liveVoice.ts`, include `temperature` only for models that support it.

Success:

- ECS logs no longer show `Unsupported value: 'temperature'` errors for live voice gate.

## Phase 1: Sample-rate alignment and audio pipeline reliability

Objective:

- Align recording and TTS output sample rate to avoid mixed 16 kHz and 48 kHz PCM going into the same encoder.

Changes:

- Record and store PCM at 48 kHz for live and composite audio.
- Resample to 16 kHz only for transcription submissions.
- Split sample-rate constants into `RECORD_SAMPLE_RATE` and `TRANSCRIBE_SAMPLE_RATE`.

Success:

- MP3 output has consistent speed and fidelity.
- Transcription accuracy improves, with fewer empty or garbled results.

## Phase 2: Snippet timing and dual-window transcription

Objective:

- Improve resilience to rapid mic toggles and UDP jitter.

Changes:

- Add a hangover buffer before snippet close, so short gaps do not fragment snippets.
- Maintain a fast window and a slow window for transcription.
- Optional coalescing pass to reconcile short and long outputs.

Success:

- Fewer ultra-short snippets.
- More consistent transcripts when speakers toggle quickly or packets drop.

## Phase 3: Composite audio with overlap

Objective:

- Produce a meeting audio artifact that preserves overlap and sounds like the room.

Changes:

- Persist per-speaker PCM with timestamps.
- At meeting end, run FFmpeg with delay and mix filters to align and blend speakers.
- Keep a sequential fallback if mixing fails.

Success:

- Composite audio includes overlapping speech with minimal artifacts.

## Phase 4: Audio eval harness

Objective:

- Allow repeatable offline evaluation of transcription output for known clips.

Changes:

- Add a new eval runner that accepts an audio clip, runs N transcription passes, and logs distribution.
- Add prompt-vs-no-prompt comparison mode and write JSON output so Monday-style vote investigations can be replayed without digging through production traces.
- Add deterministic repeated-phrase cleanup after the finalized audio pass so bursts of low-information hallucinations can be dropped even when the LLM reconcile step proposes no edits.
- Integrate with Langfuse datasets for regression tracking.
- Provide hooks for multiple STT providers and a coalescing LLM pass.

Success:

- We can compare model choices and settings for hallucination rate, WER, and stability.

## Testing and manual verification

- Unit tests for snippet boundaries, hangover logic, and resample length math.
- Manual tests for 2-person overlap and 3-person rapid keying.
- Eval tests with repeated runs on a single clip to observe variance.

## Out of scope for Phase 0

- Any changes to Terraform, AWS AppConfig, or SSM.
- Removing Discord attachments in favor of S3-only delivery.
- Multi-provider STT or coalescing logic.
