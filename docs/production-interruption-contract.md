# Production interruption and test-before-reopen contract

This is the selected A source-preparation contract for one attended introduction from the legacy runtime. It permits one initial interruption, then requires isolated fixture acceptance before ordinary admission reopens. Deployment release is a separate final operation. It does not authorize execution or establish production readiness.

The [staged fence-and-drain protocol](production-introduction.md) remains separate. Its workflow, strict manifests, receipts and unavailable-authority refusals are preserved. A uses `introduce-production.yml`, `production-manifest.cjs` and `introduce-production.cjs`. The staged protocol uses `production-introduction.yml`, `staged-production-manifest.cjs` and `staged-introduce-production.cjs`. Neither protocol's evidence authorizes the other.

## Present execution status

Current source is **unsupported for A activation**. Deploy Frontend and Deploy Docs acquire static AWS credentials. Terraform Apply retains conditional static acquisition for Sandbox. The fixed original seven-role declaration cannot establish those credentials' identity or permissions, so source verification refuses before acquiring the hold and at every fresh launcher check. This is not evidence that any named credential exists. Separate source and identity review is required before activation.

Positive protocol tests use explicitly synthetic OIDC-only reviewed source, with hashes bound to those exact fixture bytes. They still exercise actual collectors, authority checks and transactions. They do not establish compatibility of the checked-out deployment workflows.

## Admission and retained ownership

Serving readiness is distinct from permission to introduce new work. The durable introduction hold closes ordinary admission. It does not terminate existing sessions, personal processing, recovery, billing owners, their renewals, controls or completion. Coordinator expiry never releases the hold.

Only the first approved legacy stop may interrupt work. No subsequent failure permits another forced interruption, deletion of live leases or replay of an uncertain effect. Submitted, directly acknowledged and observed stages remain separate. Matching readback cannot turn an unknown acknowledgment into success. A completed duplicate callback does not settle a previously retained unknown billing owner.

Fixture authority is an original durable grant for one exact queued request and preassigned meeting, with resolved destinations. A public request flag, allowlist, copied reservation or caller-supplied hash cannot create it. Personal fixtures are outside this contract. History completion must match the live fixture snapshot, capture lineage and direct upload receipt before the owned transition.

Preparation does not prove complete retained-work classification. Final acceptance recollects retained work before each closing action. Persisting acceptance, reopening admission and releasing deployment each use a separate atomic transaction, current mutable guards and original expiry. Expiry stops dispatch but does not erase a directly received late acknowledgment.

## Finite capacity and source evidence

The original package remains limited to 200 actions and 262,144 bytes. No supplemental file can add omitted original identity, launcher or policy slots. The early capacity screen occurs before interruption and is non-atomic. The final transaction also checks the 100-target, 4 MB transaction and 400 KB item limits before reservation or submission. History growth may make the final package too large and extend maintenance.

Only strictly observed version-4 action rows covered by the supported-source immutability rule may be omitted from final transaction conditions. All mutable conditions remain. Maximum normal and repair renewal envelopes have local synthetic evidence; this does not prove fit for accumulated production history.

Original and fresh launcher checks require positive classic branch protection. Ruleset-only configuration, ambiguous 404, missing read scope or unreadable policy is unsupported. No threshold, policy exemption or relaxed identity check repairs missing evidence.

## Reviewed writer boundary

Mechanical closure covers admitted application runtimes and the reviewed deployment and launcher routes. The fixed inventory contains ordinary deployment, private Terraform Apply, the staged introduction workflow and the retired manual force-deployment script. The staged workflow keeps its read-only session policy and unconditional post-bind authority refusal. Unknown, older or resumable foreign runs remain blocking, including staged runs. There is no generic read-only exemption.

The ordinary backend role is selected only through `PRODUCTION_BACKEND_DEPLOY_ROLE_ARN`. No legacy-variable fallback is accepted. Actual role identities, policy versions, trust, repository variables and credential availability must match the original declaration and fresh observations. Source declarations do not prove installation or global IAM completeness.

The privileged recovery-publication CLI remains outside application runtime admission and retained-owner collection. Before execution, private activation review must independently establish no active or unresolved prior publication operation and freeze both publication Apply and S3-writing reconcile from before introduction through final deployment release. Read-only preview retains its existing boundary. This is an operational exclusion, not a source-enforced lock or evidence that the freeze holds. Upstream terminal or verified publication status after ambiguous PATCH or storage acknowledgment is not direct acknowledgment for A. Missing independent disposition evidence blocks activation.

## Private Terraform and the prerequisite exception

Plan and Apply retain private captures, native producer identity, complete bundle verification, lockfile and Terraform version checks, approval chronology and unknown-command or capture-acknowledgment refusals. Public output remains sanitized. The real dispatcher reaches the normal hold inspection before production preparation and a fresh guard at the actual saved-plan Apply boundary.

Only the authenticated private `deployment-prerequisites` bundle can provide a process-local exception for a genuinely missing Control table. Its restored plan bytes must match the reviewed bundle, and its private JSON projection must pass the four-target validator. The targets remain the Control table, spare target group, deployment-control policy and deployment-routing policy. The existing KMS key must be unchanged. Replacements, moves, imports, deletions, unrelated managed changes and backend-role provisioning are refused.

Ordinary full plans, denied reads, caller Booleans, hashes and copied objects cannot supply this exception. Standalone renewal coverage Apply remains disabled. The audit is read-only and cannot install or refresh recovery records. Restoring writes needs a separately reviewed admitted executor.

## Connection-sync role exposure

The existing production OpenAI connection-sync job retains its serving-service pointer and project selection. It uses the existing disabled-default prompt-guard OIDC role, verifies the exact account and session, and checks the durable hold before reading the existing OpenAI key and immediately before Langfuse publication. It does not select the latest family revision.

The source policy expands that existing role for all its trusted consumers. It permits DescribeServices for the exact serving service, GetSecretValue for the one existing OpenAI secret's current version, and Decrypt on its actual key through Secrets Manager with caller-account and exact secret encryption context. DescribeTaskDefinition needs a separate wildcard-resource statement restricted to the configured region. IAM does not enforce a task-family boundary for that operation. Source validates the exact serving ARN, account, region and family before using the project.

The original launcher declaration also binds and freshly rereads the consumed `SECRETS_PREFIX`, `LANGFUSE_BASE_URL` and `ECS_TASK_FAMILY` selectors alongside the account, region, service and role. Missing selectors refuse; source defaults are not proof of original settings.

The tradeoff is exposure of that one OpenAI key and regional task-definition metadata to other trusted prompt-guard consumers. No new role, token, job or static fallback is added. Actual provisioning, retirement of old credentials and effective permissions remain separate execution prerequisites.

## Release prerequisites and evidence limits

The legacy production restoration changed the available deployment baseline. Private owner evidence must refresh the working rollback image, immutable image availability, existing TTL and storage-cost implications, exact role/settings compatibility, capacity and retained effects before any attended window. No historical task revision or completed deployment status proves availability.

Prerequisite infrastructure remains separately reviewed. A draft source comparison does not approve provisioning or supersede its dependency review. PR CI builds local images without publication; production or manual deployment routes require separate authority. Source validation must not build or push a candidate image as a substitute for runtime evidence.

Local Node 24.18 results are not CI Node 24.15 parity. Local mock provider transports and loopback DynamoDB transactions are source evidence, not hosted CI, account identity, effective IAM, deployment, live model, customer or production proof.
