# ADR-20260916: Recording Processing Outcomes

Status: Accepted
Date: 2026-09-16
Owners: Recording processing and meeting delivery

## Context

A completed recording could have no notes for several reasons. The existing
meeting lifecycle and delivery state did not distinguish an expected empty
recording from partial transcription or a processing failure. Treating all
three cases alike hid useful results or presented expected empty input as an
error.

## Decision

Add optional processing metadata to in-memory meetings and persisted meeting
history. It records separate transcription, notes, and summary outcomes without
changing the meeting lifecycle or delivery result.

Generate notes when usable transcript text survives an unrecovered
transcription failure. Show a separate incompleteness notice with those notes.
When processing finds no usable speech and no unrecovered failure, skip note
generation and explain the empty result. Keep both notices outside notes,
transcripts, prompts, correction input, and revision history.

Do not infer outcomes for legacy records. Preserve retry, cancellation,
permission, artifact access, and audio retention behavior.

## Consequences

Users can distinguish an empty recording, partial transcription, and a failed
recording in Discord and the meeting detail view. Partial recordings retain
usable notes, while empty recordings avoid unnecessary model calls.

Consumers must treat missing processing metadata as unclassified. Processing
and delivery remain separate fields, so a successful generation result can
still have a delivery failure.

## Alternatives Considered

1. Add lifecycle states for empty, partial, and failed processing. This would
   mix meeting lifecycle with processing results and change existing consumers.
2. Put warnings into generated notes. This would persist operational text and
   leak it into corrections, exports, and prompts.
3. Infer legacy outcomes from missing notes or transcripts. Missing data does
   not prove that processing completed with an empty result.

## Notes

The change adds no database table, migration, PostHog event, production
configuration, or automatic re-transcription. Local implementation does not
establish deployment status.
