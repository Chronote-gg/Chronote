# ADR-20261028: Meeting Processing Retry

Status: Proposed
Date: 2026-10-28
Owners: Recording processing and meeting delivery

## Context

A provider outage can leave a saved server meeting with failed or partial
transcription, notes or summary while its audio is still stored. Until now
the only fix was an operator script making hand-built production writes. The
2026-09-16 processing outcomes ADR recorded outcomes but deliberately added
no retry.

## Decision

Add a retry job that is stored on the MeetingHistory row and run by an
API-runtime worker.

- New optional MeetingHistory fields:
  - `processingRetry`: the job state, attempt count, settings source and
    failure reason.
  - `processingRetryQueue` and `processingRetryDueAt`: the job's keys in a
    new sparse KEYS_ONLY GSI, `ProcessingRetryDueIndex`.
- A conditional write on the row queues the job. That write also enforces a
  single job per meeting.
- `updateMeeting` gains a `regeneration` mutation. A single conditional write
  saves regenerated content, `processing`, `transcriptS3Key` and the terminal
  job status, and requests Discord delivery.
- `NotesEditSource` gains `processing_retry`.
- Transcription retries prefer per-speaker checkpoint audio, then the mixed
  audio. Notes use frozen checkpoint snapshots when present, otherwise current
  settings, and the job records which one it used.
- The final write requires the notes version captured at request time. A
  retry never replaces notes with a human-sourced history entry.

## Consequences

- Owners can recover failed meetings from the portal, and operators can queue
  incident-wide retries without hand-written database updates.
- MeetingHistory gains one GSI, which needs a Terraform apply before the
  feature flag is enabled.
- A retry that uses current settings can produce notes that differ in style
  from the server's other meetings recorded at the same time.
- Legacy rows without `processing` remain ineligible, consistent with
  ADR-20260916.

## Alternatives Considered

1. Queue in `MeetingControlCommand`. Rejected: its commands have a 15 minute
   TTL, it is bot-bound, and it exists for live controls.
2. Reuse `updateDeliveryQueue` with a second queue value. Rejected: publication
   repair and deployment settlement own that attribute and would silently drop
   or overwrite a retry.
3. A separate job table. Rejected: it needs a second write and leaves a gap
   between saving and queuing that the row-level design avoids.
4. Inline retry inside the API request. Rejected: jobs can run for minutes
   and must survive deploy handoff.

## Notes

The design is in
`docs/superpowers/specs/2026-10-28-meeting-processing-retry-design.md`.
