# Hallucination audit workspace

This folder contains scripts and artifacts used to audit transcription hallucinations.

Key docs

- docs/hallucination-audit-20260210.md
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/report.md
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/summary.md

Scripts

- analysis/hallucination-audit/run_audit.py
- analysis/hallucination-audit/compute_audio_volume.py
- analysis/hallucination-audit/download_full_audio.py
- analysis/hallucination-audit/transcribe_full_audio.py
- analysis/hallucination-audit/align_with_full_transcript.py
- analysis/hallucination-audit/create_langfuse_dataset_sample.py

Notes

- Large audio and raw traces are tracked with Git LFS via .gitattributes.
- If Git LFS is not installed, run `git lfs install` before adding or committing.
