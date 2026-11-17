# ADR-20261111: Simplify the meeting lifecycle and deployment

Status: Accepted

Date: 2026-11-11

Owners: Meeting lifecycle

## Context

The deployment coordinator, the runtime handoff protocol and the recovery framework turned ambiguous outcomes into durable states with no expiry and no automatic resolution: a per-server voice record left `joining` or `uncertain`, an in-memory work counter that was never settled, a `needs_reconciliation` recovery disposition, a blocked local cleanup, a finalization that kept renewing its lease, and a deployment control record left mid-phase.

Those per-meeting states fed worker-wide and deployment-wide gates. A deployment required zero work counters and a valid cleanup receipt for every local directory on the serving task. The gates guarded the only repair path: replacing the task cleared in-memory counters and local disk, and a deployment shipped a fix. One imperfect meeting could therefore block its server, hold a worker open and refuse every deployment, including the one carrying the fix.

The warm handoff the machinery was built for did not happen in production, which runs one task. Production deployments went from reliably succeeding to mostly failing or being cancelled once the coordinator was introduced, and 29 of the last 60 merged pull requests repaired the machinery itself.

## Decision

Remove the mechanisms instead of adding expiries to each of them. The design follows these rules:

1. S3 is the truth for audio. A piece is safe when its upload succeeded.
2. The MeetingHistory row is the truth for the meeting. Its terminal status is written before anything is posted.
3. The per-server lease is the only lock on recording and covers capture only. Ending a capture always frees the server.
4. A worker that no longer holds a lease does nothing visible in that server.
5. Local disk is a cache. No decision depends on it.
6. A worker's death is a normal event. Shutdown is a tidy version of the same path.
7. Each step is idempotent and skips itself when its durable output exists.

Concretely: identical workers register themselves in the deployment control table and the newest ready release takes new work; one `finish` pipeline with a normal loader and a recovery loader saves and delivers every meeting, driven by a finisher loop with bounded retries; task protection covers captures only and expires by itself; and one deploy script (`scripts/deployment/deploy.cjs`) waits for at most one previous drain, rolls out, waits for readiness and rolls back on failure. Every wait has a deadline and every failure that needs a person raises an alarm. Operation is described in [the deployment document](deployment.md).

## Consequences

- A captured meeting reaches a terminal state on its own, and a server can start a new meeting as soon as its previous capture ends.
- Meeting starts stay available during a normal deployment, and a deployment needs no manual step.
- A meeting whose worker dies ends where it died, with partial notes marked interrupted. It is not rejoined.
- Delivery is at least once. Notes can be posted twice in rare cases, in exchange for never blocking on an uncertain send.
- A meeting still unfinished 24 hours after its capture began is marked failed without a post.
- While an old worker drains, both tasks serve portal requests, and a live transcript served by the worker that is not recording shows status only.
- A deployment that arrives during a drain waits for it, up to the length of a meeting, unless dispatched with `retire_older_tasks`.
- A recording that starts on the new worker during a drain may be unprotected until the drain ends.
- A meeting that ends on a draining worker is finished by another worker from S3: it has no raw chat log object and its final pass runs on a mix rendered from the pieces.
- The first deployment needs one operator `StopTask` at an idle moment and has a start gap of about two to four minutes. There is no return to the old protocol after cutover.
- Meetings left unfinished by the old runtime are finished only by an operator command, never automatically.
- The finisher scans the whole MeetingHistory table every minute, a known ceiling; an index on open meetings is the upgrade.
- Unused infrastructure (the spare target group, the weighted listener, coordinator IAM, the voice alarms) stays in place for one release.
- Deferred, in order: bot and API as separate services; steady state with more than one worker; scaling on capture count; a per-meeting memory budget; continuing a live recording on another worker; Discord sharding.

## Alternatives Considered

- Add an expiry or a reconciliation step to each stuck state. Rejected: each fix adds another state and another operator tool, and the gates would still guard the repair path.
- Keep the warm handoff with generations and promotion. Rejected: production runs one task, the handoff did not occur in practice, and its protocol was the main source of failed deployments.
- Rejoin a live recording on another worker after its worker dies. Deferred: it needs voice ownership transfer that this pass does not attempt.
- Finish meetings left by the old runtime automatically. Rejected: whether to post old notes is a customer decision, so it stays with the owner.
- Split the bot and the API into separate services now. Deferred: it removes the mixed portal traffic during a drain but is not needed for correctness.

## Notes

- Supersedes [ADR-20261020](adr-20261020-production-legacy-introduction.md), [ADR-20261025](adr-20261025-production-interruption-contract.md), [ADR-20261026](adr-20261026-original-paused-draft-acquisition.md), [ADR-20261028 cold cutover](adr-20261028-production-cold-cutover.md), [ADR-20261103](adr-20261103-voice-leave-always-sent.md), [the deployment drain design](superpowers/specs/2026-10-12-deployment-drain-and-interruption-design.md), [the voice acknowledgment recovery design](superpowers/specs/2026-10-31-voice-acknowledgment-recovery-design.md) and [the recovered notes publication design](superpowers/specs/2026-11-02-recovered-notes-first-publication-design.md).
- Design: [lifecycle simplification](superpowers/specs/2026-11-11-lifecycle-simplification-design.md). Tracks #609, #119, #490, #541, #564, #493 and #64.
