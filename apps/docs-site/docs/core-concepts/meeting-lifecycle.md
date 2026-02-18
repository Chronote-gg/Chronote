---
title: Meeting Lifecycle
slug: /core-concepts/meeting-lifecycle
---

Chronote treats each recording session as a meeting lifecycle with clear stages.

## Stages

1. **Start**: a meeting starts manually (`/startmeeting`) or through auto-recording.
2. **Capture**: Chronote captures voice audio, channel chat, and attendance.
3. **Process**: audio is transcribed, cleaned, and transformed into notes.
4. **Publish**: notes are posted to Discord and stored in meeting history.
5. **Revise**: authorized users can suggest and apply minimal note corrections.

## Context and quality

- Server and channel context improves summary quality.
- Dictionary terms reduce confusion around team-specific language.
- Audio guardrails help filter silence and low-confidence segments.
