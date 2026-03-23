---
title: Transcription reliability guardrails
slug: /whats-new/transcription-reliability-guardrails
---

Chronote now applies extra transcript verification and cleanup steps to reduce punctuation-only outputs and repeated greeting-style hallucinations.

## What changed

- Low-confidence prompt vs no-prompt retries now reject punctuation-only results such as `.` before they can win transcript selection.
- Finalized meeting audio can be re-checked at meeting end to apply high-confidence transcript fixes before notes are generated.
- Repeated short phrases from the same speaker, such as duplicate greetings, are filtered during the final transcript cleanup pass.
