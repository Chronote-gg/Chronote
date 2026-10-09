# Hallucination audit workspace

This folder contains reusable scripts for transcription hallucination audits.

These are historical operator tools from February 2026. Meeting-specific findings
and the original mitigation plan are retained in private `chronote-ops`, under
`evidence/2026-02-hallucination-audit/`. Their dated recommendations are not current
runtime acceptance evidence.

Scripts

- analysis/hallucination-audit/run_audit.py
- analysis/hallucination-audit/compute_audio_volume.py
- analysis/hallucination-audit/download_full_audio.py
- analysis/hallucination-audit/transcribe_full_audio.py
- analysis/hallucination-audit/align_with_full_transcript.py
- analysis/hallucination-audit/create_langfuse_dataset_sample.py

Notes

- Raw meeting artifacts are intentionally not stored in this branch.
- Keep audio files and raw trace dumps in approved private storage, outside Git.
- Default trace and meeting output directories are ignored by Git. Keep any
  custom output location outside the public repository. Provider calls require
  the applicable access and billing authorization.
- Install the locked Python environment with `uv sync --frozen`. Audio tools also
  require `ffmpeg` and `ffprobe` on PATH.
- Offline correctness checks: `uv run --frozen python -m unittest discover -s analysis/hallucination-audit`.

The audit reads transcription observations through Langfuse Observations API v2,
using bounded start times and cursor pagination. `--name` matches the observation
name. JSON I/O is decoded locally and guardrail metadata is requested untruncated.
Exports retain both trace and observation IDs; duplicate grouping and dataset item
IDs use observations so snippets sharing a trace stay separate. Existing raw dump
filenames are retained. Dataset creation also supports historical trace exports.
