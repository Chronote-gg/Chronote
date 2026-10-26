# Carry unresolved Sandbox history into normal deployment

The explicit carryforward operation preserves an availability-restored source-loss incident as unresolved history and installs one new normal deployment. That deployment may complete only after its actual source drains and retires. Normal future protected deployments may then resume. The original lost owner receives no fabricated acknowledgment or settlement.

This differs from availability recovery, which keeps ordinary deployment blocked. Use carryforward only under an explicit reviewed approval accepting normal future protected deployment while the historical incident remains unresolved. It grants no production scope or historical billing exception.

## Private operation packet

`carryforwardManifestSchema` in `scripts/deployment/carryforward-manifest.cjs` defines the strict packet. Hash it with canonical `bindingHash`: recursively sorted object keys and UTF-8 JSON, preserving array order and values.

| Field                      | Required value                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| `version`, `kind`          | `1`, `sandbox_historical_carryforward`                                       |
| `operationId`              | Newly reviewed UUID, consumed once                                           |
| `policy`                   | `normal_protected_deployments_with_unresolved_history`                       |
| `operatorExclusion`        | `exclusive_approved_writer_window`                                           |
| `accountId`, `region`      | Exact approved Sandbox route                                                 |
| `sourceCommit`             | Exact reviewed tooling commit, matched to workflow source                    |
| `imageSourceCommit`        | Separately reviewed image provenance commit                                  |
| `image`                    | Exact Sandbox image digest reference                                         |
| `templateArn`              | Exact immutable reviewed task-definition template                            |
| `preparedDefinitionSha256` | Canonical prepared registration fingerprint                                  |
| `controlSha256`            | `bindingHash(controlAuthority(currentControl))`                              |
| `recoverySha256`           | Canonical hash of the complete original version2 SOURCELOSS row              |
| `originalRunToken`         | Original source-loss deployment token                                        |
| `approveBefore`            | Epoch seconds, in the future and at most 24 hours away at initial validation |

Tooling and image provenance are distinct. An already-reviewed immutable image may be used with a reviewed flag template, without a rebuild when runtime code is unchanged. Native checks bind the actual digest. `imageSourceCommit` records approved provenance; tooling CI does not authenticate that provenance or prove application acceptance.

Compute the prepared fingerprint as `bindingHash(candidateDefinition(template, { tablePrefix, image, candidateId: operationId }))`, using the exported coordinator helper. It strips AWS response metadata, replaces image and operation candidate ID, and retains stopTimeout120. The actual registered definition must then match through `bindingHash(taskDefinitionInput(actual))`, without rewriting its image, candidate ID or settings.

Only the three explicit intro-ledger, subscription-transition and renewal-grace flags may differ from the current source template. Values must be explicit true/false strings. Other settings, secret references, table route, Dev client identity, Stripe test mode and runtime mode remain unchanged. Flags do not establish feature prerequisites. Historical intro eligibility retains its existing conservative coverage rule.

`controlAuthority` binds token/epoch/expiry, serving generation/members, full deployment and compatible-replacement lineage. It excludes only the independent recovery scan cursor. The archive contains the full observed Control snapshot; a legitimate cursor update remains preserved by the transaction and is not claimed as an atomic historical cursor snapshot.

## Inspect, review and execute

1. Complete exact-source review/CI, reviewed flag/template plan and saved-plan apply, then the exclusive approved writer inventory. Terraform registration alone does not move the service.
2. Retain the packet privately. Create only a newly owned, previously absent Sandbox secret `SANDBOX_CARRYFORWARD_MANIFEST`. Never overwrite an existing secret. Its JSON is exposed only to carryforward actions. Keep provider details out of public inputs, artifacts and logs.
3. Dispatch a new attempt1 of Sandbox Deployment Identity at the exact reviewed source with `continuation_action=inspect-carryforward` and `carryforward_manifest_sha256=<packet hash>`. Leave continuation binding empty, terminal-proof input empty, bootstrap none/empty and denial probe false.
4. Independently retain the full private binding through the actual-principal host metadata route. Use exported `createCarryforwardInspection`, `createCoordinator().inspectServing`, the schema and pure fingerprint helpers with an adapter that refuses every write and out-of-packet resource. Label the real host actor separately from workflow OIDC. Never invoke the executable wrapper by spoofing STS, workflow identity or session. The gated inspection must independently prove actual OIDC and return the same checksum.
5. Dispatch one new attempt1 at the same source with `continuation_action=carryforward`, the same packet checksum and `continuation_binding_sha256=<reviewed inspection hash>`. Preserve Sandbox environment binding, OIDC and shared deployment concurrency. An environment name does not establish a required-reviewer rule.
6. Verify actual new generation, exact task/image/template-derived definition, own readiness, native protection, acknowledged routing and public health. Verify genuine recovered-source retirement and preserved old incident/guards. Refresh writer/coverage for the actual image, then continue the approved billing matrix.
7. After reconciled execution, delete only the temporary secret this operation created. Retain packet, original receipt, archive, workflow and acceptance receipts privately. Preserve uncertain operations for review.

The approval UUID is one-use authority. The numeric execution run cannot be known before dispatch. The first valid exact-source execution consumes the UUID atomically and records its actual run token and OIDC actor. Reruns and second invocations refuse. Expiry limits initial consumption; a validly started drain does not abandon work when that timestamp passes.

The historical source token may contain any positive attempt number, such as `123-2`. Only the new carryforward execution is restricted to attempt1.

## Atomic archive and normal handoff

One transaction conditionally matches original Control authority, all original recovery attributes and the source's fresh admission proof. It puts `CARRYFORWARD#<operationId>` / `ARCHIVE` if absent and installs normal `preparing` Control. Serving membership/generation remain unchanged. The SOURCELOSS row is condition-checked and never modified.

The archive is append-only under this protocol, not IAM-immutable against privileged replacement. It has no TTL. It records full observed prior Control, recovery key/hash, actual source, policy, target/template fingerprints, tooling/image provenance, consumed execution identity and pending settlement. Its partition stays outside the strict runtime record union. Running protocol version1 schemas are unchanged.

The source must refresh its own readiness at the new epoch. Normal preparation warms a protected candidate, promotion transfers admission and routing, and retirement requires the actual source's acknowledgment and native convergence. Only the new operation reaches complete. There is no empty Control interval or transient false old completion.

After writer inventory and other awaited reads, late authority checks validate exact identities, current-generation readiness, unexpired coordinator authority, native protection and stable Control. Listener submission also checks fresh native routing and the exact source action. Carryforward CLI calls use one transport attempt. Unknown listener acknowledgment retains the submitted fence; observing intended weights never authorizes replay.

After promotion, the outgoing source retains its original authorized generation and may disable admission readiness while draining. Its native protection is checked independently until an exact current-operation retirement request and acknowledgment prove all seven work counts are zero. The final read must confirm that acknowledgment before accepting released protection, including when release occurs during the awaited checks. Unknown or incomplete retirement preserves the operation for review.

The observer counts historical archives separately and retains pending source-loss counts. Its aggregate deploymentIncomplete may remain true for historical obligations after a new normal deployment completes. That signal is neither the authorization rule nor proof of settlement.

## Writer exclusion and refusal boundaries

Minimal `actions: read` permits completely paginated queued/in-progress/waiting/requested/pending inventory for Sandbox backend, Sandbox identity and Terraform Apply. The current exact-source attempt must be proved; every other candidate operation must be absent. Unclassified applies refuse. Inventory repeats before writes. Each page must support ETag revalidation. Repeated authenticated reads send its exact validator and accept saved data only after a live 304 response. This avoids charging unchanged pages against the primary API quota during a long drain, as described in [GitHub's conditional-request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).

This remains operational exclusion. Shared concurrency does not serialize Terraform apply or raw API use. A metadata snapshot cannot physically fence a credential holder who starts an out-of-contract operation later. Historical retryable raw/lease-only code must be operator-excluded. Actual competing or unexcludable operations stop this procedure; required narrow authority changes retain their separate scope. No IAM, role, environment-protection or credential change occurs here.

Changed source/image/template, stale proof, changed recovery receipt, active prior lease, mismatched binding, occupied/foreign routing or incomplete inventory refuses. A lost atomic response is accepted only by exact archive and Control readback. Otherwise preserve uncertainty.

After an archive exists, never redispatch carryforward or reset its approval. Inspect the current normal operation and use only an applicable existing normal recovery protocol with fresh checks and recorded authority. Do not replay uncertain service/listener operations, delete archives, force completion, clear work/voice/effect guards or reinterpret missing billing history as eligibility.
