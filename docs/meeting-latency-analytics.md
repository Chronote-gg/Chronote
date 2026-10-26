# Meeting notes delivery latency

The existing `meeting_completed` event adds version 3 timing for initial Discord notes delivery. It measures the wait from actual capture stop to acknowledged notes delivery. Recording length, processing outcomes and delivery quality keep their existing meanings. This contract adds no response-time promise, model change or delivery-routing change.

## Event compatibility

Version 3 retains every version 2 property and the existing guild and acting-user identity path. `duration_ms` remains the existing recording duration calculated from `meeting.endTime` and `meeting.startTime`. It is not notes wait. `notes_generated` remains the requested generation flag. `transcription_outcome`, `notes_outcome`, `history_persistence`, `notes_delivery` and `usable_notes` retain their existing semantics.

Only these shape-only properties are added:

| Property                             | Meaning                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes_latency_status`               | `measured`, `partial`, `unknown` or `not_applicable`.                                                                                                                              |
| `notes_first_delivery_latency_ms`    | Numeric elapsed milliseconds from actual capture stop to the first acknowledged initial notes message. Present for `measured` and `partial` only.                                  |
| `notes_complete_delivery_latency_ms` | Numeric elapsed milliseconds from actual capture stop to acknowledgement of all initial notes messages. Present for `measured` only.                                               |
| `notes_delivery_path`                | `live` or `recovery`, the source of the first observed acknowledgement. Present when valid timing identifies that source and notes are eligible, even if the stop time is unknown. |

Eligibility requires requested transcription and notes, without actual cancellation. A failure does not become inapplicable merely because generation or delivery failed. The existing completion lifecycle still decides whether an event exists. Generation flags do not establish delivery quality. No content, additional identifiers, provider references, financial amounts or per-server dollar fields are sent.

Version 2 events remain valid for existing outcome analysis. They lack observed latency and must not be interpreted as zero wait. Outcome reports should accept both versions 2 and 3. Latency charts must select version 3 and the appropriate measured status. Never backfill old events from ingestion timestamps or recording duration.

## Clock and delivery rules

The clock starts at the terminal `meeting.recordingCaptureState.endedAt`, persisted as `MeetingHistory.capture`. It never starts at `meeting.endTime`, recovery start, interruption detection or the last confirmed audio timestamp. Missing, malformed, nonfinite, negative or unordered timing is unknown and contributes no elapsed value.

The acknowledgement clock is observed immediately after Discord's notes send resolves, before the existing durable metadata write. The first timestamp belongs to the first notes batch. Complete timing belongs to the last intended notes batch. A later batch failure preserves first-only timing. Summary messages and no-speech notices do not count. A delivery acknowledgement does not prove human visibility or readership.

`notesDeliveryTiming` is optional and records initial notes version 1 only. First timing and its path stay immutable. Completion can be added once and cannot be replaced. Consequently, `path: live` can include a first acknowledgement in live processing followed by completion in recovery. The path does not establish that every batch or processing step ran in that mode. Later corrections preserve initial timing.

Timing joins existing owned acknowledgement and history writes. It adds no extra remote write, timer or send. Optional invalid timing and analytics failure must not block finalization. Existing ownership fencing, exact previous-value proof and uncertain-delivery no-resend behavior still apply.

## Coverage and analysis

A first acknowledgement with a known original stop is `partial` until all initial notes messages are acknowledged. Valid first and complete times produce `measured`. Eligible attempts without valid paired clocks are `unknown`. Disabled notes or transcription and intentional cancellation are `not_applicable`. Unknowns never become zero latency.

The completion event covers only attempts that reach the existing completion capture. Failed processing, pending work and interrupted recovery can be absent. Recovery does not emit another completion event. Independent start and completion totals are not matched cohort evidence.

The private history report must match each original initial delivery once, including recovered delivery against its original capture stop when known. It must show eligible pending and failed attempts, partial delivery, missing timing and legacy coverage separately. Recovery-first timing is observable from the stored path; mixed live/recovery delivery is not fully described by that path. Financial inputs and reconciliation belong to the separate private report and remain unchanged.

First-message and complete-message percentiles answer different questions. Complete-wait percentiles describe successfully measured complete deliveries only, not all requested notes. Pair percentiles with sample size, cohort dates, eligible attempt counts, pending/failure counts, partial delivery counts and missing timing coverage. Do not add stage percentiles together. Existing Langfuse spans can diagnose stages without a second timing lifecycle.

## Predeployment requirements

1. Publish the [privacy policy](../apps/docs-site/docs/legal/privacy.md) and [What's New notice](../apps/docs-site/docs/whats-new/meeting-processing-times.md), including its [index entry](../apps/docs-site/docs/whats-new/index.md), before widened backend capture takes effect. A source commit or green docs build is not publication evidence.
2. Migrate existing outcome consumers from an exact `event_version = 2` filter to acceptance of versions 2 and 3. An existing saved report was verified to filter version 2, so this is a release prerequisite. Review other consumers for the same assumption. Keep their existing outcome semantics and validate version 3 inclusion. Dashboard changes require their own authorized operation; this code change does not modify external reports.
3. Keep deployment and any controlled recording or paid evaluation under their applicable separate authorization. No new config or deployment workflow is needed for this contract.
4. After authorized deployment, verify actual capture stop, first and complete acknowledgements, durable history and ingested numeric fields. Collect a dated real baseline with sample sizes before claiming observed notes wait.

Source, local tests, CI, merge, publication, deployment and live acceptance are separate evidence. Until live verification and a dated baseline exist, total notes wait remains unverified.
