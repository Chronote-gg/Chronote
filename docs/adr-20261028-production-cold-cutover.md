# ADR-20261028: Cold cutover for the first production introduction

Status: Accepted; supersedes the staged fence-and-drain path for the first introduction

Date: 2026-10-28

Owners: BASIC

## Context

The [staged introduction](adr-20261020-production-legacy-introduction.md) needs a post-bind human gate, private durable delivery and a trusted collector before it can run, and none exist. Production stays on the legacy runtime meanwhile. BASIC asked for a simple answer that never stops the legacy task over a meeting.

## Decision

Cut over only when nothing is in flight. `production-cutover.yml` checks leases, queued or claimed meeting controls, and unfinished personal upload jobs and segments immediately before stopping the legacy task and again after it stops. Work before the stop defers the run with no service change. After the stop, the run restores service with the master candidate and reports any work or meeting history growth from the stop window as an incident. BASIC's sign-off is the native environment approval of the exact run, verified in code. The run reuses the Sandbox cold-bootstrap engine for Control initialization, launch and promotion, and leaves no introduction hold.

## Consequences

A meeting that starts after the pre-stop check is cut off when the legacy task stops. The run detects it but cannot prevent it. The cutover causes API, bot and webhook downtime from the stop until the candidate is ready. Legacy is never relaunched automatically and no rows are deleted or force-expired.

## Alternatives Considered

1. Unblock the staged fence-and-drain engine. It needs dependencies that do not exist yet.
2. Relaunch legacy after a detected race. That replays the old runtime against work the candidate must own.

## Notes

Operator steps, the race window and resume rules are in the [production introduction procedure](production-introduction.md#cold-cutover).
