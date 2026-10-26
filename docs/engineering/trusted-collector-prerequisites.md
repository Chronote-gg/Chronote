# Trusted collector prerequisites

The trusted production-introduction collector still refuses final proof. These
prerequisites do not implement a successful empty or populated engine proof and
do not authorize a production operation.

## Implemented source

`collector-metadata.cjs` selects ECS task, task-definition, service and ECR image
metadata before the inventory can be retained. It keeps environment variable
names and validated Secrets Manager references, never environment values. It
accepts only the existing fixed startup command grammar. A missing command has
no verified runtime mode. Captures identify this as `ecs-metadata-v1`, a selected
projection rather than the original provider response. Other inventory families
still require their own containment review.

`createPreparationCapture` uses the existing private capture store. Its strict
identity consists of `kind`, `operationId`, `sourceSha`, `evidenceStoreId` and
`validUntil`. The only kinds are `production-introduction-preparation` and
`rehearsal-introduction-preparation`. The namespace is derived from kind,
operation and source. Existing store ownership, encryption, privacy, lifecycle,
retention, exact byte hash and version checks remain in force. No arbitrary
namespace or new storage destination is supported.

`captureWindowsHost` is a fixed local Windows CIM reader. It requests boot,
reader identity and process identity metadata without command lines or
environment values. It captures the selected projection through the preparation
store. `verifyWindowsQuiescence` checks the host, boot, preparation identity,
freshness, process tree and approved window.

The current host profile refuses every additional `cmd.exe`, `node.exe`,
`powershell.exe` or `pwsh.exe`, even if unrelated to Chronote. Only the calling
Node collector and its own PowerShell reader are exempt. Missing, cyclic or
reused-parent ancestry and collector descendants refuse. This deliberately
narrow profile will reject ordinary operator sessions with other script hosts.
It has synthetic test coverage only, with no accepted live host acquisition.

## Required composition remains incomplete

The preparation identity and controlled window are review inputs. They do not
prove authority, source provenance, process immutability or future launch
exclusion. The final factory must acquire exact private scope references, bind
the canonical finite writer scope to the manifest, and verify source, operation,
host, freshness and the full authority interval before consuming a host capture.
That factory integration is absent. Current absence cannot prove a particular
historical process exited, settle its effects or establish historical no-launch.

Old-process HTTP request settlement also remains unresolved. Upload completion
can verify an intake token before expiry, await a storage HEAD request, then
queue work after expiry. Current row status, expiry, route closure and repeated
snapshots cannot prove that such a request has settled.

A later fresh-row profile may use exact private GetItem/projected-digest equality
and creation during the same native task/source observation window with complete
writer coverage. Older or ambiguous rows need original authenticated issuance
and independent effect settlement. A successful future fixture for fresh rows
would not establish acceptance of the current production inventory. No such row
profile is implemented by these prerequisites.

Application credential lifetime, input compatibility, object stability,
publication/financial effects, complete known-writer coverage and successful
engine composition remain separate required work. Keep the final collector's
refusal until those contracts are implemented and independently reviewed.
