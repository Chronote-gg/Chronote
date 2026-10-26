# Shared meeting update delivery

## Status

Accepted.

## Date

2026-10-23.

## Owners

Chronote maintainers.

## Context

An acknowledged notes save must survive interruption before Discord delivery. Notes, titles and warnings can change independently, and an older delivery completion must not acknowledge newer work.

## Decision

Supported intentional edits use one shared action to persist canonical content and compact delivery intent atomically on the existing meeting row. A sparse due index discovers work for a bounded worker. No database Streams or new queue service were added. Arbitrary manual database writes do not trigger synchronization.

Expose a sanitized delivery projection separately from canonical save acknowledgment and initial publication evidence. Only verified current convergence confirms a synced revision. Last success records a captured attempt and may describe older work.

## Consequences

Pending work survives process restart. Known failed logical attempts count once across restarts, with a limit of eight, rather than counting individual HTTP calls. Definite rate-limit timing is honored; other known failures use jittered backoff from five seconds to five minutes. Exhaustion stays visible with desired work retained.

Unknown submitted effects use GET-only reconciliation and can hold newer edits. Lease expiry alone never authorizes replay. Missing recorded posts are not recreated automatically. Independent part watermarks and retained pagination evidence cost additional state and conditional writes.

Deploy the ACTIVE due index before code. There is no Scan fallback, historical backfill, or blanket replay. Initial publication, exceptional approved repair, Notion automation and notifications retain distinct ownership and rules.

## Alternatives Considered

In-request fan-out leaves a gap after saving. A separate outbox table adds transaction and lifecycle overhead. Streams were rejected in the approved design because publication follows supported intentional actions.

## Notes

See [delivery outcomes](discord-delivery-outcomes.md) and [exceptional publication repair](operations/recovery-discord-publication.md). Code validation does not establish hosted Sandbox acceptance or authorize production deployment or live hold release.
