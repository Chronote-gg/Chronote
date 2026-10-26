# Sandbox recovery after source loss

The separate source-loss executor restores availability using the existing candidate when the original serving task has stopped. It leaves lost-owner settlement pending and ordinary deployments blocked. The healthy-source continuation keeps its original refusal checks.

## Execution boundary

Use the existing Sandbox Deployment Identity workflow on an independently reviewed source commit. Select `continuation_action=inspect-source-loss` first. This performs metadata reads and prints the frozen binding checksum. Retain the private operation packet and compare the original deployment, source, surviving candidate, generation, image, immutable task definitions, billing flags and routing topology.

After reviewing the fresh packet, select `continuation_action=recover-source-loss` with `continuation_binding_sha256` set to that checksum. The existing `sandbox` environment binding, scoped OIDC identity and deployment concurrency group apply. Respect configured approvals; the environment name alone does not establish a required-reviewer rule. Workflow reruns, mixed bootstrap operations and missing checksums refuse before role assumption. Use a new workflow run, never replay an uncertain operation.

Stopped-task records have a limited provider retention window. If the exact source lookup becomes `MISSING`, this executor is unavailable and a separately reviewed procedure is required. Historical receipts do not replace the fresh native check.

The executor verifies the actual OIDC session and Sandbox account/resource route. It requires native `STOPPED` for the exact source task. `MISSING`, a stale heartbeat or an empty target group alone cannot substitute. The service must have one exact protected, ready candidate, no pending replacement, an empty source group, and the original acknowledged source listener action. The immutable candidate definition must retain Stripe test mode and disabled intro-offer, subscription-transition and renewal-grace gates. Existing renewal-reactivation configuration is included in the reviewed binding and remains unchanged.

Admission and the durable receipt commit atomically through conditional DynamoDB operations. The candidate must then publish its own fresh heartbeat and readiness at the new generation. Routing uses the existing submitted-request fence, one listener call, and exact acknowledgment. Authority, native identities, protection, target health and the expected source listener action are checked again before submission.

This path cannot build or launch an image, register a definition, stop a task, release protection, clear a lease or voice guard, or replay an external effect. A receipt from any prior attempt blocks another execution. Preserve its state for separately reviewed reconciliation.

## Availability is separate from settlement

The operator receipt uses `SOURCELOSS#<originalRunToken>` / `RECOVERY` in DeploymentControlTable. It has no TTL. Runtime point readers and the existing `ENV` runtime query do not read this partition. The strict runtime record union and Control phases are unchanged.

The receipt progresses through `admission_transferred`, `forward_submitted` and `availability_restored`. Its settlement remains `lost_owner_settlement_pending`, with reason `incomplete_durable_effect_ledger`. No automatic `source_loss_settled` transition exists. The original deployment stays `promoting` or `promoted`; its source runtime receives no fabricated retirement acknowledgment.

Metadata scans retain source-attributed claims, history dispositions, processing claims and voice guards, with complete pagination. The receipt records that dated snapshot. Scans exclude meeting content and raw command result/error bodies. Empty scans cannot recover the stopped runtime's in-memory effect acknowledgments. Completed personal processing can also precede ancillary export. Each scan is bounded to 100 pages of 100 items and at most 100 source-owned rows per table. Larger or incomplete results refuse recovery. The snapshot records its collection time and may precede the fresh admission inspection; it is observational and does not authorize settlement.

The deploy role lacks reads for some ancillary ledgers; expanding that role would not reconstruct the lost evidence.

An unknown listener result leaves `forward_submitted` unresolved. Intended weights observed later do not authorize another listener request or completion. A lost DynamoDB response can be accepted only through exact readback of the atomic Control and receipt state.

## Operator acceptance

The billing owner verifies the exact candidate image serving through the acknowledged listener, healthy targets, HTTP 200 health/readiness, native protection, Dev bot identity and Stripe test mode before resuming the approved billing tests. Source CI alone proves none of those hosted outcomes. Preserve all unresolved source work and guards under their existing fenced recovery protocols.

The deferred voice retest and paused recording watch remain separate. Production recovery is outside this executor's scope.

Deterministic refusals and race tests live in `test/scripts/sandboxSourceLoss.test.js`. Native DynamoDB transaction and preserved-guard tests live in `test/deployment/sourceLoss.integration.test.ts`. The observer reports availability-restored and settlement-pending receipt counts separately.

## Approved retained-stop evidence path

The separate retained path accepts an operator-captured historical native stop response for the exact original operation. Human approval accepts that capture trail; neither a checksum nor the workflow authenticates it as an AWS-signed attestation. The original native-STOPPED path never reads this packet and still refuses MISSING.

The billing operator verifies the complete original snapshot's raw SHA-256 locally and retains those bytes unchanged. Extract only the source task metadata and `continuationBinding(historicalControl, exactCandidateIdentity)`. The resulting private packet has the following strict shape, exported as `packetSchema` from `retained-stop-proof.cjs`:

| Field                      | Meaning                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `kind`          | `1`, `operator_retained_ecs_stop`                                                                                                                       |
| `accountId`, `region`      | Exact approved Sandbox account and region                                                                                                               |
| `capturedAt`               | Offset-aware ISO time, after source stop and no later than execution time                                                                               |
| `originalSnapshotSha256`   | Raw original file checksum, a provenance reference checked locally, not recomputed from omitted bytes                                                   |
| `provenance`               | `operator_captured_provider_response`                                                                                                                   |
| `operationBinding`         | Exact historical `continuationBinding` object, matched to fresh original Control and candidate before writes                                            |
| `sourceTask`               | Exact `taskArn`, `clusterArn`, `taskDefinitionArn`, `group`, last/desired `STOPPED`, `stoppedAt`, positive native `version`, and one selected container |
| `sourceTask.containers[0]` | Exact `name`, `imageDigest`, lastStatus `STOPPED`, integer `exitCode`                                                                                   |

The terminal-packet checksum is `terminalPacketSha256(packet)`, the existing `bindingHash` algorithm. It recursively sorts object keys and hashes the UTF-8 JSON serialization with SHA-256. JSON whitespace and object-key order do not matter; array order and metadata values do. This checksum is distinct from the original snapshot's raw-byte checksum.

Create only the newly owned Sandbox environment secret `SANDBOX_SOURCE_LOSS_TERMINAL_PROOF`, after confirming that name is absent. Never overwrite an existing secret. Deliver the packet JSON there, and pass its reviewed canonical checksum as `source_loss_terminal_proof_sha256`. No provider payload belongs in public inputs, artifacts or logs. The workflow exposes this secret only to its retained executor step.

Select `continuation_action=inspect-retained-source-loss`, with only the terminal-packet checksum. After reviewing the fresh operation binding, use one new run with `continuation_action=recover-retained-source-loss`, the same terminal-packet checksum, and `continuation_binding_sha256` from inspection. Original native actions require an empty terminal-packet input. Reruns, bootstrap mixing and missing proof checksums refuse before authentication.

Every native source read must return either the exact matching STOPPED task or exactly one MISSING failure for that full source ARN, alongside the exact current candidate. Live, conflicting, ambiguous, denied or failed reads refuse. Source and candidate identities, immutable definitions, original operation, chronology, cluster/account route and current routing remain bound. Admission and listener protections are unchanged.

Retained recovery writes operator receipt version2 with `terminalProof` recording the packet checksum, original checksum, capture time, operator provenance and actual native observation (`MISSING` or `STOPPED`). It preserves `lost_owner_settlement_pending` and the original runtime acknowledgment gap. The packet is never labeled fresh or signed provider evidence.

After reconciled execution, the billing operator deletes only the temporary secret it created and retains the private original packet and operation receipts. An uncertain operation must keep its evidence for reconciliation. This path authorizes availability recovery only. The later billing feature rollout and its deployment-authority changes require their own reviewed contract.

### Independent private binding read

The gated inspection prints only its checksum. To retain the full binding independently, use the existing account-asserted host metadata route and label its actual STS principal as host observation, separate from the workflow's OIDC principal. Run `assertSandboxScope` against current Control, create the validated `createRetainedStopProof` from the approved local packet, then call `createSourceLossInspection(...).inspect()` and `sourceLossBinding(control, candidateIdentity, terminal)` with the returned fields. Save that object and `bindingHash` privately.

Use a provider adapter that refuses every write and every resource outside the reviewed Sandbox packet. The inspector needs only DeploymentControl GetItem/Query, ECS service/task/definition/revision/protection reads, and ELB listener/rule/group/target reads. It needs no audio, notes, transcript or credential read. Do not call `recoverSandbox`, bypass an identity check, substitute a fake STS result or print the private binding. The actual gated inspection must independently prove the scoped OIDC identity and return the same binding checksum before execution.
