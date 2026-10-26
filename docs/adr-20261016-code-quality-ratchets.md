# ADR-20261016: Git-relative code quality checks

Status: Accepted  
Date: 2026-10-16  
Owners: Chronote maintainers

## Context

Absolute complexity limits accumulated suppressions and did not prevent growth inside suppressed code. Chronote needs local feedback for coding agents and an enforceable PR decision without a repository-wide cleanup requirement.

## Decision

Consume the pinned BASIC-BIT/quality-ratchet root action and strict local CLI, pinned to the same full commit. Chronote owns `quality-ratchet.json`; the target branch's policy applies to both trees. The shared tool owns Git-relative duplication, complexity, and file-size checks for authored JavaScript/TypeScript, including tests. Use limits of 15 complexity, fewer than 1,000 lines for new files, and duplicate blocks of at least 8 lines and 50 tokens.

One persistent PR-wide `quality-exception` label plus a written rationale may accept regressions. It never waives operational or unrelated CI failures. A dedicated required check validates current metadata, with up-to-date enforcement in branch rules. Lizard remains diagnostic.

## Consequences

Improvements tighten the next PR's baseline. Accepted regressions become legacy debt. Tests may need shared setup, and branch updates may be required after unrelated merges. Function names and callback ordinals have documented matching limits. Local contributors need a separate clean tool checkout and locked dependencies. Chronote retains only consumer integration contracts and a thin launcher, so engine fixes require a reviewed shared release and pin update.

## Alternatives considered

Repository-wide hard caps would require exclusions immediately. A stored violation inventory would add state Git already provides. Separate or per-push exemptions add operator work.

## Notes

See the maintained [shared design](https://github.com/BASIC-BIT/quality-ratchet/blob/0873869f6b8fd80150d24689849ec0aebd94e9dd/docs/superpowers/specs/2026-10-16-quality-ratchet-design.md), the original [Chronote design](superpowers/specs/2026-10-16-code-quality-ratchets-design.md) and [operating guide](engineering/code-quality.md). Source verification, hosted behavior, and branch-rule activation are separate acceptance steps; this ADR records the approved decision, not proof of activation.
