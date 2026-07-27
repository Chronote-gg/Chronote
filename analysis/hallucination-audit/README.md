# Hallucination audit workspace

This folder contains reusable scripts for transcription hallucination audits.

Key doc

- docs/hallucination-audit-20260210.md

Scripts

- analysis/hallucination-audit/run_audit.py
- analysis/hallucination-audit/compute_audio_volume.py
- analysis/hallucination-audit/download_full_audio.py
- analysis/hallucination-audit/transcribe_full_audio.py
- analysis/hallucination-audit/align_with_full_transcript.py
- analysis/hallucination-audit/create_langfuse_dataset_sample.py

Notes

- Raw meeting artifacts are intentionally not stored in this branch.
- Keep large audio files and raw trace dumps in dedicated audit branches or local workspace storage.
