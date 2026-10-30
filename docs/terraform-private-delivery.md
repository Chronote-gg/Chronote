# Private Terraform plan delivery

The manual Terraform workflows keep saved plans, Lambda archives and command output in the existing versioned private capture store. Public Actions output contains status, a logical bundle label and SHA-256 digests. A plan file may contain credentials even when its rendered output hides them. Do not use public artifacts or paste private locators into dispatch inputs.

This source supports an approved private store and a narrowly defined native GitHub approval gate. No store, KMS key, retention horizon, administrator trust, permission grant or environment protection setting has been selected by this change. Live use requires separate configuration approval and harmless acceptance of the native metadata checks. The production-introduction workflow's separate post-bind authority refusal remains unchanged.

## Review and apply

1. A separately authorized plan invocation uses the intended source revision, environment, workspace and scope. Production pairs with `default`; Sandbox pairs with `sandbox`. Sandbox Plan accepts only `meeting-update-delivery`, `processing-retry` and `sandbox-site-permissions`. Production Plan accepts only `deployment-prerequisites`, `deployment-runtime`, `site-delivery` and `processing-retry` and refuses other scopes before acquiring AWS credentials. The shared invocation schema and separate Production Apply scope contract are unchanged. Both workflows validate the environment/workspace pairing before configuring AWS credentials.
2. Before Terraform runs, the job verifies the private storage controls and durably retains an invocation intent. The shared command boundary sets `TF_WORKSPACE` from the validated invocation before the first backend initialization for both Plan and Apply, replacing any inherited workspace. Explicit workspace select/new commands clear that override so Terraform accepts them, and their arguments must still match the validated invocation workspace. Other commands retain the binding. Production uses `default`; Sandbox uses the existing `sandbox` workspace and never creates it. It captures exact stdout and stderr privately for version, init, workspace selection, validation, plan and show. The plan exit codes distinguish changes, no changes and failure.
3. The private bundle contains the saved plan, rendered review text, command output, plan checksum, Lambda checksums and exact supported Lambda ZIP bytes. Each file has a byte length and SHA-256. The bundle binds repository, source commit, workflow, run, first attempt, environment, workspace, scope, Terraform version and provider-lock hash.
4. An authorized reader obtains the exact object version through the approved private storage route, verifies the complete object hash against the public bundle digest and reviews its contents. The capture key derives from the invocation and digest. Its version identifier and bounded reference remain private. The producing runner retains the returned reference locally; an authorized private-store reader can recover the exact version and construct the same reference from its metadata. That reader route and access must be accepted before live use. No public reference delivery or automatic latest-version lookup is provided.
5. Configure the exact private reference as the protected environment secret `TERRAFORM_PLAN_REFERENCE_JSON`. Dispatch apply from the plan source commit or a later `master` commit with the plan run ID, logical `artifact_name`, original `plan_sha256`, entire `bundle_sha256`, matching environment/workspace/scope and the existing `apply` confirmation. The label has the form `terraform-plan-<environment>-<workspace>-<runId>`. It is not an Actions artifact or an S3 URL. Confirmation alone grants no apply authority.
6. Review the native environment request for that apply run. The run name includes the immutable environment/workspace/scope, producing run and both digests. A late private-reference change cannot substitute a different bundle that happens to share its plan hash.
7. Apply verifies native producer success before consumer creation, the plan source named by that run and first-attempt identity, the actual individual review, unchanged protection configuration, storage controls and exact version bytes. It verifies every file before restoring anything, uses readonly provider locking, checks Terraform version and rendered review correspondence, then applies the saved plan without replanning. Apply output is a separate capture linked to the reviewed bundle and actual invocation.
8. A later Apply commit must descend from the plan source (GitHub compare status `ahead`) and leave every Terraform input unchanged: `_infra/**`, `scripts/deployment/**`, `patches/**`, `.yarn/**`, the Plan and Apply workflows, `package.json`, `yarn.lock`, `.nvmrc`, `.node-version`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `scripts/ci-install-dependencies.sh`. Apply refuses and names the first changed input path. It also refuses a behind or diverged commit, a comparison listing 300 or more files (GitHub's cap) and an unavailable comparison. The Apply intent records both invocations and the source relation (`identical` or `ahead`), so a merge such as a docs change no longer forces a re-plan.
9. Apply runs in its own `chronote-terraform-<environment>` concurrency group, so a merge-triggered deploy cannot displace a queued Apply, but nothing serializes the two either. Immediately before `terraform apply`, production Apply therefore refuses if `deploy.yml`, `production-cutover.yml`, `introduce-production.yml` or `production-introduction.yml` has an in-progress, queued, waiting or pending run. That check is a snapshot, not a lock: a deploy that starts after it can still overlap the Apply, and the cold cutover writes no introduction hold for the writer guard to see. Avoid merging while an approved Apply is running. The writer guard reads the hold's `deployment.state` directly, so a later commit's compiled `src/` cannot change it, and Apply no longer builds `dist/`.

## Required configuration

Production Plan assumes `vars.TERRAFORM_AWS_ROLE_ARN` through GitHub OIDC with an account-restricted read, backend-lock and private-capture session. The role source supports the four-target `deployment-prerequisites` graph and the `deployment-runtime` graph described in [`_infra/README.md`](../_infra/README.md); the live role needs the widened inline policy from `_infra/production-bootstrap` installed before a runtime Plan. The session also allows the site bucket and secret metadata reads that graph refreshes. Its CloudFront reads serve the `site-delivery` graph; the runtime graph no longer reads CloudFront. Its CloudWatch Logs, CloudWatch alarm and SNS topic metadata reads serve the `processing-retry` graph. The workflow refuses `full`, `purchase-permission` and other scopes before authentication; those scopes need a separately reviewed permission closure before use. Before acquiring credentials, it derives and masks expected production identities from the existing private storage binding. A boolean variable comparison refuses foreign identity tuples before logging their values, then a strict JavaScript check verifies the exact account, role and control table, including case. The hold-guard environment values are scoped to the final private Plan step. Plan reads sensitive application state and writes backend locks and private evidence; it cannot write application state or application data through this session. Sandbox Plan and the separate Production Apply identity are unchanged. Live configuration and execution still require their own approval.

Tfvars inputs are unchanged. `TERRAFORM_PRIVATE_STORAGE_JSON` is an environment secret containing the strict `versioned-private-s3-v1` binding accepted by `scripts/deployment/private-capture.cjs`: store ID, bucket, expected account owner, region, KMS key ARN, reviewed bucket-policy and lifecycle hashes, retention-until epoch seconds and administrator-trust digest. Do not place the binding in dispatch inputs. It selects no destination by default.

New bindings should set `policySha256` to `bindingHash(JSON.parse(policyText))` using `scripts/deployment/binding-hash.cjs`. This digest sorts object keys recursively and ignores JSON whitespace while preserving every value and array order. Existing raw-text SHA-256 bindings remain accepted for the exact policy text they bind. This changes only policy representation handling; SDK attempts, storage controls and native approval requirements remain unchanged.

To migrate an existing raw-text binding, independently compare and review the complete current `GetBucketPolicy.Policy` JSON string against the approved policy. A raw digest alone cannot be converted into a canonical digest. From the reviewed repository root, compute the new value from the reviewed policy, keeping the existing `policySha256` field:

```js
const { bindingHash } = require("./scripts/deployment/binding-hash.cjs");
const canonicalHash = bindingHash(JSON.parse(reviewedPolicy));
const migratedBinding = { ...reviewedBinding, policySha256: canonicalHash };
```

Update the protected binding through its approved private configuration route and reapprove any enclosing request or manifest hashes that bind the changed JSON. Keep the complete reviewed policy and migration output private. This procedure does not authorize secret updates, permission changes or deployment.

Captured objects retain their exact original-byte hashes. The separate `_infra/production-bootstrap` and `_infra/sandbox-bootstrap` saved-plan guards retain their `policySha256` maps and exact policy-string byte checks; those bindings do not use this migration.

The capture adapter verifies versioning, bucket-owner-enforced ownership, Block Public Access, nonpublic policy, approved SSE-KMS with bucket keys disabled and the exact lifecycle configuration. The single encryption rule may omit `BlockedEncryptionTypes` or report exactly `{ EncryptionType: ["SSE-C"] }`; other encryption rule shapes refuse. Enabled expiration rules refuse. Retention must cover at least the next six hours at each invocation. Execution identities must have separately approved capture/read permissions and no delete or storage-administration authority. Versioning does not prevent an administrator from deleting evidence.

Three non-secret collection inputs use JSON text in their GitHub Actions variable values:

- `TFVAR_PRODUCTION_INTRODUCTION_TASK_DEFINITIONS`: an array of exact task-definition ARN strings.
- `TFVAR_PRODUCTION_INTRODUCTION_STANDALONE_TASKS`: an array of exact task ARN strings, or `[]`.
- `TFVAR_PRODUCTION_ACCEPTANCE_FIXTURES`: an array of objects with exactly the string fields `guild_id`, `voice_channel_id` and `meeting_id`.

The renderer decodes only these declared collections into JSON arrays before Terraform reads them. Terraform still validates exact resource scope, cardinality and fixture identities. It canonicalizes these three suffixes, `FRONTEND_DISTRIBUTION_ID`, `DOCS_DISTRIBUTION_ID`, `ENABLE_PRODUCTION_INTRODUCTION_ROLES`, `ENABLE_PRODUCTION_ACCEPTANCE_COLLECTOR` and `ENABLE_PRODUCTION_PROMPT_GUARD_ROLE` to their declared lowercase names. GitHub stores Actions variable names in uppercase, so a flag missing from this list reaches Terraform as an undeclared name and silently keeps its default. Other input names and scalar behavior remain unchanged. Malformed JSON, null/scalar/mixed collections, duplicate keys and conflicting aliases refuse before output, without logging values. Credential overrides are refused before collection decoding. Keep these non-secret values in readable Actions variables, not the credential-bearing tfvars secret. This transport does not select live values or enable any role.

`TERRAFORM_PLAN_REFERENCE_JSON` contains the adapter's exact `storeId`, `namespace`, `key`, `sha256`, `size` and non-null `versionId`. Terraform namespaces are derived from the strict invocation as `terraform/<environment>/<runId>/1/<invocationDigest>`. Production and rehearsal introduction namespaces keep their existing validation and are never used as substitutes.

The JSON capture limit is 32 MiB, including base64 encoding. A command's combined raw output has a 24,000,000-byte in-memory bound after its complete local streams have been written. An oversized bundle or output refuses durable completion and preserves local bytes; it never truncates. A larger legitimate plan needs a reviewed delivery change before use.

## Supported native approval profile

The supported profiles share one environment job, one required-reviewer rule, one individual User reviewer, an explicit boolean native `prevent_self_review` setting and explicit native `can_admins_bypass: false`. Sandbox requires no branch policy. Production requires exactly one additional native `branch_policy` rule and `deployment_branch_policy` flags `protected_branches: false` and `custom_branch_policies: true`. Other rules, duplicates, teams, absent fields, multiple or missing reviews, rejections, reruns, mismatched sources and unsupported metadata refuse.

The selected source behavior permits the same person to dispatch and explicitly approve when the native required-reviewer rule has `prevent_self_review: false`. That person must be the configured individual and must provide the actual approved review for this exact run and environment. With `prevent_self_review: true`, the reviewer must differ from both the dispatcher and triggering actor. Missing or malformed settings refuse; no dispatch confirmation or caller Boolean substitutes for native approval. This source choice does not authorize a live setting change.

Production also reads the authenticated [deployment branch-policy list](https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies) with `per_page=100`. It requires an explicit total count of one and exactly one policy with a positive native ID, name `master` and explicit type `branch`. The consumer run must also name branch `master`. Missing type, tags, wildcards, extra policies, incomplete counts, linked pagination and unreadable evidence refuse before bundle retrieval. The complete response is retained in the approval proof and must remain unchanged immediately before and after Apply. This uses the existing Actions-read token; it neither changes protections nor accepts a null production policy.

The verifier also reads the separate [custom deployment protection rules endpoint](https://docs.github.com/en/rest/deployments/protection-rules#get-all-deployment-protection-rules-for-an-environment). It requires an explicit zero count and empty rules array and includes that response in the unchanged-protection comparison. Missing or enabled custom rules refuse this supported profile.

The environment configuration must predate consumer creation. Its identity, rules, native bypass field, complete branch-policy proof and `updated_at` must remain unchanged at the pre-apply and post-apply checks. `updated_at` describes configuration timing, never approval timing. Approval comes from the actual review-history entry for the exact consumer run and environment. The producer must already have completed successfully before that consumer was created. The job token only reads repository Actions metadata; no organization audit credential or new approval service is used.

GitHub's [REST run and review metadata](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run), [environment metadata](https://docs.github.com/en/rest/deployments/environments#get-an-environment), and [input-based run names](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name) supply the documented fields. Native run names bind the producer environment/workspace/scope and consumer digests through the trusted workflow source. Review history has no approval timestamp or bypass indicator.

The REST schema omits `can_admins_bypass`. Its native mapping is accepted under implementation ruling 15 using the GitHub-maintained provider and its pinned SDK:

- [Provider resource at 1b9c5c13](https://github.com/integrations/terraform-provider-github/blob/1b9c5c13eb840a72c99d088f3bf3b5e00b950c04/github/resource_github_repository_environment.go) reads `env.CanAdminsBypass` from `GetEnvironment`.
- [Provider dependency pin](https://github.com/integrations/terraform-provider-github/blob/1b9c5c13eb840a72c99d088f3bf3b5e00b950c04/go.mod) selects `github.com/google/go-github/v92 v92.0.0`.
- [SDK mapping at 5149b4d7](https://github.com/google/go-github/blob/5149b4d74590b63154fcc43c4dac05e881f9aea3/github/repos_environments.go) maps `CanAdminsBypass *bool` to `json:"can_admins_bypass,omitempty"` on the Environment response from the native repository environment endpoint.

Missing, null, true or nonboolean values refuse. Offline fixtures prove composition only. Harmless native acceptance must prove explicit false-field behavior, normal approval, no-review refusal and bypass refusal before an apply is authorized. If native behavior differs, stop for a reviewed correction.

## Isolated bootstrap verification

`verify-production-bootstrap.yml` is a separate manual production job. It does not run Terraform, inspect application state or deploy a service. Its approved source and private binding must be frozen before dispatch. The job requires the existing native production approval, master branch, first run attempt and exact `source_sha` input. The `deadline_utc` input bounds the operation to at most the next hour; the job and restricted OIDC session last at most fifteen minutes.

Configure only the environment secret `BOOTSTRAP_VERIFICATION_STORAGE_JSON`. The secret is a strict object with `environmentId` and `binding`; `binding` uses the existing `versioned-private-s3-v1` storage schema. The runner derives the fixed Terraform role ARN from the validated binding account. `storage_sha256` is the SHA-256 of the exact secret text, including its whitespace. This isolated name does not activate the ordinary Plan, Apply or deployment workflows.

The runner checks native approval before acquiring credentials, verifies the actual STS identity, and uses the shared capture adapter for a small synthetic payload and encrypted result report. Its session permits bucket-control reads, only this run's synthetic keys and report prefix, and the existing KMS key through S3. Duplicate conditional creation must return 412; missing write conditions, wrong encryption and a latest-version read must return 403. These are observed effective-session results, not proof of every base-role denial. Unexpected success or an ambiguous acknowledgment stops the run without cleanup or retry.

One Node process owns the deadline from native approval through the final storage proof. It requests a token through the documented GitHub Actions OIDC environment variables, refuses redirects and non-GitHub Actions HTTPS origins, bounds the token response, and passes the restricted policy directly to the single 900-second STS assumption. It refuses ambient AWS credential routes and gives subsequent clients only the returned short-lived credentials. A wall-clock check before each request stops acquisition or storage work after expiry. The policy and private account/resource values never pass through action inputs or outputs.

Private run intent, approval proof, started/terminal API receipts and final references stay under the runner's `bootstrap-verification` temporary directory. The encrypted report also contains the actual caller, probe receipts and their digest. An exclusive attempt marker precedes the first OIDC request and refuses a second execution. Tokens and credential responses stay in memory and are excluded from the journal. Public output contains only status and hashes. A separate authorized administrator must recover the exact synthetic report/payload versions and verify their hashes before accepting storage access. Runner-local files alone do not provide durable acceptance, and an interrupted run must not be replayed to recreate its report.

Source and fixture tests do not authorize configuration, workflow dispatch, OIDC assumption, synthetic writes or production changes. Those require a separate exact-operation approval.

## Failure and reconciliation

Capture creation is conditional and has one SDK attempt. The job never retries an uncertain write or apply. Intent JSON, returned references, complete child stream files and failure details remain under the private runner temporary directory. They are not uploaded as public artifacts and are not deleted by a cleanup step. A terminated or lost runner may make those local bytes unavailable; missing evidence is UNKNOWN.

An apply command with a lost acknowledgment, changed protection metadata after apply, or failed durable output capture returns UNKNOWN. Preserve evidence and reconcile the intended object version and Terraform/provider state through separately authorized read-only operations. Do not rerun apply to recreate output, infer success from missing logs, or treat a fresh dispatch as reconciliation. An oversized capture likewise requires a reviewed next step. No automated recovery or provider replay is part of this workflow.

## Sandbox delivery prerequisites

The `meeting-update-delivery` scope is valid only for the Sandbox environment and existing `sandbox` workspace. It supplies exactly two fixed targets: `aws_dynamodb_table.meeting_history_table` and `aws_iam_policy.dynamodb_access_policy`. Workspace selection fails if Sandbox has not already been installed.

Before publishing a successful bundle, Plan privately renders `terraform show -json tfplan` through the command capture boundary. Apply renders the restored, verified binary again immediately before starting the effect path. Both checks bind the account and region to the strictly validated private storage binding. They accept only the exact Sandbox delivery GSI and DescribeTable resource addition, or the completed state with no changes. Extra managed effects, imports, moves, replacement, deferred changes and unknown security fields fail closed. AWS 6.69.1 computed index capacity and key-schema fields are permitted only with explicit fixed keys and PAY_PER_REQUEST billing. Private command JSON stays in the existing capture, while public results contain status and digests.

The `processing-retry` scope is valid for Sandbox (`sandbox` workspace) and Production (`default`). It targets the MeetingHistory table and the processing retry worker failure filter and alarm described in [`_infra/README.md`](../_infra/README.md), and `scripts/deployment/validate-processing-retry-plan.cjs` checks both the Plan and the restored Apply plan in either environment. The Sandbox base role and session read only table and key metadata, so a Sandbox plan works only while Sandbox alerting is off and the counted filter and alarm have no instance. Enabling Sandbox alerts needs a separately reviewed Sandbox role widening first. In production, apply the bootstrap root's `enable_processing_retry_policy` before Plan, because Plan needs that policy's log, alarm and topic reads. Production also lacks `UpdateDeliveryDueIndex`, which no workflow here adds there, so the scope refuses until a one-time operator `UpdateTable` adds it. The filter and alarm name the log group and alerts topic instead of referencing them, so the closure excludes the KMS key policy and pending site or key policy drift does not block this scope.

Sandbox workflows assume `vars.TERRAFORM_AWS_ROLE_ARN` through GitHub OIDC and constrain `vars.AWS_ACCOUNT_ID`. They have no static credential fallback. Production Apply uses its reviewed upstream OIDC identity and production hold guards. Production Plan uses the account-restricted OIDC route described above. The current Sandbox route accepts only `meeting-update-delivery`, `processing-retry` and `sandbox-site-permissions`. It refuses `full`, `purchase-permission`, `deployment-prerequisites`, missing scopes and incompatible saved bundles without coercion. The shared invocation boundary enforces this before storage checks, capture or Terraform execution, and each workflow validates dispatch inputs before requesting AWS credentials. Production Apply retains its existing scope contract. Production Plan is limited to `deployment-prerequisites`, `deployment-runtime`, `site-delivery` and `processing-retry` by its pre-credential gate; existing hold/approval checks remain. Any future Sandbox scope needs a separately selected and reviewed credential closure before this restriction can change.

Sandbox Plan adds a restrictive STS session policy. Its positive metadata read patterns intersect the base role's exact action and resource permissions. The base role must continue to restrict dependency reads, backend lock keys, the evidence bucket/prefix and KMS context. The session permits GetObject only for the custom Sandbox state key pattern `*/meeting-notes-terraform/sandbox/meeting-notes-terraform/state`, backend lock item operations, and capture PutObject/GetObjectVersion under `*/terraform/sandbox/*`. It grants no application writes, policy-version writes or state PutObject. The read patterns in this session restriction do not replace the base role's exact permissions. The workflow tests check the actual decoded JSON input against STS's 2,048-character limit.

OIDC configuration, source checks and mock provider fixtures do not establish native installation, approval, plan, apply or acceptance success. The protected private storage binding and plan reference remain the existing environment secrets.

After separating the application KMS key policy from the key, the delivery targets have a source-derived dependency closure of 30 DynamoDB tables, the target IAM policy and the application KMS key. The separate key policy is a reverse dependent. CloudFront, application buckets, ACM, Route53 and Terraform data sources are outside this closure. The delivery guard rejects all data-source entries; the Plan session restriction omits the former CDN/DNS/certificate read patterns. Capture bucket control checks and backend state reads remain required.

For a delivery-only Sandbox where `ProcessingRetryDueIndex` is confirmed absent, set the Sandbox GitHub Actions variable `TFVAR_ENABLE_PROCESSING_RETRY_INDEX=false`. Its default is `true`, preserving the retry index definition for existing users. The `false` setting omits only that index and its `processingRetryQueue` and `processingRetryDueAt` key attributes; it preserves `UpdateDeliveryDueIndex` and `GuildTimestampIndex`. A `processing-retry` Plan needs the variable unset or `true`; with `false` the Plan cannot add the index and the scope verifier refuses it.

Confirm absence before choosing `false`. Removing an existing retry index is not authorized by the delivery-only scope. If the plan proposes that removal, the unchanged delivery guard must refuse it; stop and obtain a separate reviewed migration rather than widening the guard. This Terraform flag does not enable runtime retries. `meetings.processingRetry.enabled` remains independently controlled and must stay off until its index is ACTIVE and runtime enablement is separately authorized.

## Sandbox site permissions

Use `sandbox-site-permissions` only with GitHub environment and Terraform workspace
`sandbox`. It targets exactly `aws_iam_policy.site_publishing[0]` and
`aws_iam_role_policy_attachment.site_publishing[0]`. It permits policy creation or a
policy-only in-place update, attachment creation and complete validated no-ops.
Deletion, replacement, import, move, failed or unknown checks, resource drift and
unrelated managed writes refuse. This installation operation is pinned to
`meeting-notes-sandbox-site-publishing` and `meeting-notes-sandbox-github-deploy`.

First install and verify the separately reviewed Sandbox bootstrap runner grant
using [its bounded existing-policy saved-plan procedure](../_infra/sandbox-bootstrap/README.md#bounded-existing-policy-update). The reviewed bootstrap binding adds the two non-secret bucket inputs and an independently observed previous-policy hash. Its only managed update is the runner inline policy; trust, backend, capture storage and encryption remain unchanged. Missing authoritative bootstrap inputs stop installation. The application operation does not change the
bootstrap root. The policy must grant exactly the reviewed bucket/object,
distribution and application-key permissions from `_infra/site-publishing.tf`.
Both site buckets, the existing deployment role and application key must be known
and unchanged. The application key must equal the private storage binding key;
sharing a key is verified here, never inferred. Account and region must agree
between the verified storage binding and current `GITHUB_VARS_JSON`. Supply both
site bucket/distribution selectors and exactly one `TFVAR_` alias for each
distribution ID, with values identical to the deployment selectors.

A created policy may leave its computed ARN/ID unknown. An unknown attachment
policy ARN additionally requires the exact direct-reference configuration,
the reviewed LF-normalized `_infra/site-publishing.tf` source fingerprint and no
Terraform override files. This source-only normalization does not alter saved
binary, private capture or lockfile digests.

Plan keeps its read-only session. Apply prepares a compact scope-specific session
before authentication, masks selectors and policy before writing `GITHUB_OUTPUT`,
and intersects the bootstrap role with an inline allow and explicit denies.
It denies `dynamodb:UpdateTable` everywhere, site-policy create/tag/version writes
outside the exact site-policy ARN and attachment writes outside the exact
deployment-role ARN. The bootstrap policy still enforces its exact attachment
`iam:PolicyARN` condition. Other scopes retain their authentication behavior.
At the managed-policy version limit, stop instead of pruning versions.

Review the exact captured plan/bundle and request native approval using the
existing procedure above. The restored Apply plan is validated again before
mutation. Changed inputs or selectors require a new plan and review. Coordinate
with the Sandbox owner before planning or applying; source merge, bootstrap grant,
installed application policy, actual OIDC identity and successful site publishing
remain separate receipts. This source change does not authorize those operations.

## Production site publishers

The docs and frontend jobs use the existing production backend deployment role with separate site-only STS sessions. Each session can publish its own bucket and invalidate its own CloudFront distribution, plus read the production hold and use the existing key through the corresponding S3 and DynamoDB contexts. No static AWS credentials, new deployment role or IAM policy are introduced by this workflow source change. The normal hold guard runs before publication; a missing control table or unreleased hold refuses. Docs still publish before backend rollout, and frontend still waits for that backend. Existing native production approval and noncanceling deployment concurrency remain.

The merged site publishing policy and its attachment must actually be installed, along with the normal deployment identity/control prerequisites, before this route can run. Source tests and a merged policy definition do not prove effective S3, KMS, CloudFront or deployment acceptance. No plan/apply or live publication is authorized by this source proposal.
