# ADR-20261020: Separate production legacy introduction from compatible handoff

Status: Accepted for source implementation; operational activation blocked

Date: 2026-10-20

Owners: Unassigned

## Context

The legacy production runtime cannot prove the shared admission and retirement contract required by the ordinary deployment coordinator. A quiet lease scan or protected task does not prevent new legacy work. Existing recordings and unfinished uploads must survive the transition. BASIC approved preparation and a brief maintenance window after existing work finishes, with separate production execution approval.

## Decision

Use a one-time production introduction with an operation-owned admission deny, complete retained-work classification and authenticated actual-task evidence before shutdown. Bind every phase to one immutable manifest, source/run/session and current durable predecessor. Retain original captures privately before publishing compact receipt references.

Preserve submitted intent on an unknown acknowledgment and allow read-only reconciliation without replay. Pre-stop abort restores only the proved original state. Post-stop recovery may launch only the bound compatible fallback under separately approved known-failure evidence; it cannot resurrect legacy code. Completion proves restored permissions and releases introduction ownership before later deployments use normal compatible handoff.

The source-staged workflow remains blocked at the explicit post-bind human-authority boundary. Removing that boundary requires reviewed gate wiring and separately authorized harmless acceptance of the exact topology. A collector alone cannot unlock execution. Approved private durable delivery, the trusted collector/store and recovery evidence remain prerequisites.

## Consequences

Existing owners can finish while admission is fenced, and compatible unfinished uploads can carry forward without deletion. The legacy transition includes API, bot and webhook downtime. Uncertainty or expired proof can extend maintenance while the deny remains. No downtime duration or provider-delivery guarantee is accepted.

Implementation approval does not authorize infrastructure, IAM, production shutdown, financial replay or customer messaging. The production environment name supplies no approval proof. Existing Terraform raw-plan/output confidentiality must be resolved before fresh production plan/apply. Private delivery options do not select or approve a store, region, encryption, retention, IAM or bootstrap method.

## Alternatives Considered

1. Use ordinary warm handoff immediately. Legacy admission and ownership cannot meet its prerequisites.
2. Stop after a quiet lease scan or force work to expire. This can interrupt recordings or discard unfinished work.
3. Automatically relaunch legacy code on failure. This can bypass the fence and replay uncertain effects.

## Notes

The [production introduction procedure](production-introduction.md) records the staged execution refusal, remaining acceptance and operator decisions as of October 22, 2026. [Normal handoff](deployment-handoff.md) and [Sandbox bootstrap](sandbox-bootstrap.md) retain separate contracts. Exact execution evidence belongs in private operations.
