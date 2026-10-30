# Sandbox Site OIDC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining Sandbox site publishers off static root-key bindings without changing deployment behavior.

**Architecture:** Reuse the existing Sandbox deployment role and checked-in site-publishing policy. Each site gets a restricted OIDC session and exact identity checks. Install permissions before cutover; retire old bindings after successful publishing.

**Tech Stack:** GitHub Actions, Node CommonJS, Jest, Terraform, AWS IAM/S3/CloudFront/KMS.

**Spec:** [Approved Sandbox site OIDC design](../specs/2026-10-29-sandbox-site-oidc-design.md).

## Global constraints

- Preserve approval, noncanceling concurrency, optional docs behavior, production-target rejection, sync exclusions and cache settings.
- Use `SANDBOX_BACKEND_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID`, `AWS_REGION` and existing site bucket/distribution variables; one-hour publishing sessions.
- No new role, trust change, static fallback, production application deployment, customer-data reads or root-key deactivation/deletion.
- Keep production identity helpers and hold behavior unchanged. Keep private operator inputs and acceptance receipts outside source.
- Do not widen the meeting-update-delivery guard or reuse its saved plan for site-policy installation.
- Refresh default-branch source and coordinate with deployment owners before each runtime/configuration mutation. A changed source binding invalidates earlier saved-plan approval.

## Review focus

- Docs disabled: no session preparation, authentication or provider access; preserve the existing skip result.
- Malformed or cross-site selectors: refuse before authentication; a frontend session cannot publish docs or the reverse.
- Wrong or root actor: exact account/role/session verification refuses before site operations.
- Missing installed permissions: fail the affected job without static credentials or unrelated policy expansion.
- Legacy inputs or parallel deployment work: avoid recreating removed bindings or invalidating another owner's operation without coordination.

## Files and responsibilities

| Files | Responsibility |
| --- | --- |
| `.github/workflows/deploy-staging.yml` | Sandbox OIDC job permissions, session inputs, identity ordering and root-free preflight |
| `scripts/deployment/sandbox-site-session.cjs` (new) | Validate configured Sandbox site selectors, construct and mask each site's restricted policy |
| `test/scripts/sandboxDeploymentIdentity.test.js` | Actual workflow authentication, identity, gating and preflight contracts |
| `test/scripts/sandboxSiteSession.test.js` (new) | Session validation, exact policy resources/actions, masking and CLI refusal |
| `test/scripts/docsDeployment.test.ts`, existing production publisher tests | Preserve cache/skip behavior and production isolation |
| `docs/terraform-private-delivery.md`, `_infra/README.md` | Operator sequence, installed/source proof boundaries and removal of obsolete guidance |
| `_infra/main.tf`, `scripts/deployment/terraform-tfvars.py`, affected Terraform workflow/fixture tests | Later removal of the obsolete key-variable producer and its input mappings |

## Task 1: Root-free Sandbox site workflow

**Consumes:** Existing `assertSandboxIdentity(actor, env)` and existing site-policy permissions. **Produces:** Reviewed source PR; no runtime acceptance claim.

- [ ] Refresh remote `master`, inspect open deployment PRs and owner replies, preserve the isolated `codex/sandbox-site-oidc` branch and applicable AGENTS guidance. Install the repository-pinned toolchain/dependencies if absent; do not borrow an unverified dependency tree.
- [ ] Add failing tests to `sandboxDeploymentIdentity.test.js`: both site jobs have the two required permissions, Sandbox environment and existing dependencies; role/account/session inputs match; no static credential fields; identity validation occurs after auth and before S3/CloudFront calls; preflight has account/role requirements and no static requirement. Run the focused suite and retain the expected failures.
- [ ] Add failing `sandboxSiteSession.test.js` cases for `prepareSandboxSiteSession(variables, site) -> {policy, masks}`. Assert frontend/docs own-site resources and exact allowed actions; KMS S3 context; no ECS, IAM, Secrets Manager or other-site permission; serialized policy at most 2,048 bytes. Assert valid custom buckets work, invalid bucket/distribution/account/role/region or unknown site refuses, policy values are masked, and CLI failure emits only a fixed error without writing an output policy. Run and retain expected failures.
- [ ] Implement that single focused CommonJS helper using standard JSON and assertions. Inputs are the existing role/account/region and selected site's bucket/distribution variables. CLI accepts only `frontend` or `docs`, emits masks before writing `policy` to `GITHUB_OUTPUT`, and emits a fixed refusal on error. Preserve the production-only helper unchanged.
- [ ] Wire site preparation, OIDC and the existing exact Sandbox identity checker into both jobs. Session name remains `chronote-sandbox-${{ github.run_id }}-${{ github.run_attempt }}`. Use `allowed-account-ids`, `role-duration-seconds: 3600`, `unset-current-credentials: true`, account masking and the prepared session-policy output. Keep every new docs step conditional on `steps.docs-config.outputs.enabled == 'true'`. Change only the preflight credential requirements, preserving its target guards.
- [ ] Run focused new suites plus `docsDeployment.test.ts`, `sitePublisherIdentity.test.js` and existing production deployment-identity contracts using the pinned Jest runner. Run formatter checks, applicable lint and actionlint. Require terminal passes; missing tools are a gap, not passing evidence.
- [ ] Update deployment docs with the permission-install prerequisite and proof boundaries. Commit, obtain independent review, publish a source PR and attach it to this chat. Do not call it merge-ready before the exact-head 30-minute gate and complete feedback refresh.

## Task 2: Install permissions and prove the real cutover

**Consumes:** Reviewed workflow source and existing `aws_iam_policy.site_publishing[0]` / `aws_iam_role_policy_attachment.site_publishing[0]`. **Produces:** Private installed-policy, fresh OIDC and publishing receipts.

- [ ] Coordinate with active deployment owners, verify current account-admin SSO identity, exact Sandbox backend/workspace/private inputs, source and lockfile hashes, deployed role trust and absent/present policy state. Refuse source drift, unknown bindings, unrelated changes or overlapping operator work. Keep the private capture and saved-plan controls intact.
- [ ] Through the supported operator CLI, prepare a private saved Terraform plan targeting only the two site-policy addresses with the exact Sandbox inputs. Inspect plan JSON and require only the expected policy/attachment changes or their completed no-op. Refuse distribution, application, production, KMS-key or unrelated resource changes. Retain exact source, workspace, input fingerprints and saved-plan digest privately; independently review the actual plan before Apply.
- [ ] Apply only those reviewed saved bytes, verify the policy document and role attachment, and compare with the pinned source. If an appropriate supported operator path or binding is unavailable, stop installation and report the precise gap; do not add a broader workflow scope or direct IAM shortcut.
- [ ] After the source PR is merged and permissions verified, run the approved Sandbox publishing path from exact merged source in coordination with its owner. Require the actual GitHub OIDC actor, docs-enabled and docs-disabled behavior as applicable, frontend/docs job success and bounded published-site readiness. Preserve application rollout approvals and do not deploy production.
- [ ] Record source/installed/authentication/publication evidence separately. On a missing permission or wrong identity, stop and diagnose through the same role. Do not use static keys or silently expand policy. Refresh caller inventory before credential cleanup.

## Task 3: Retire obsolete bindings and close the known consumers

**Consumes:** Successful Task 2 acceptance and a fresh static-caller inventory. **Produces:** Reviewed source removal and verified GitHub configuration cleanup; both root keys remain active.

- [ ] Search all current workflows, scripts, docs, fixtures and Terraform inputs for static AWS selectors and `AWS_TOKEN_KEY`. Distinguish OIDC-produced temporary variables and synthetic fixtures from stored-key consumers. Recheck other-account cloud bindings through their supported route; preserve unknowns and recovery evidence.
- [ ] Add failing regressions to the existing Terraform-tfvars/workflow tests that own the discovered callers: the obsolete key input is not generated, the Terraform key-variable producer is absent, and temporary OIDC credentials still work. Preserve unrelated tfvars and environment-variable handling.
- [ ] Remove `github_actions_environment_variable.envvar_aws_access_key_id`, its obsolete `AWS_TOKEN_KEY` variable/mappings and confirmed obsolete guidance. Update only affected callers and fixtures. Review each environment's exact state/configuration removal separately; do not let a broad application plan remove the variable incidentally. Coordinate pending saved-plan invalidation with owners.
- [ ] Run the affected tests and existing workflow/identity regressions, review the removal diff independently and deliver its source PR. After merge and exact removal-plan approval, remove only the proven obsolete repository/environment AWS key variables/secrets. Do not remove OIDC role/account selectors or vault values still retained for other consumers.
- [ ] Verify names-only GitHub readback, fresh root-free source/configuration checks, and a fresh replacement-path acceptance. Update private consumer/lifecycle records with original evidence and current dispositions. Keep the unidentified second key, cached clients, excluded stores and any unverified account unresolved. No root-key deactivation or deletion follows automatically.

## Self-review and execution

Spec coverage: Task 1 covers workflow/session safety; Task 2 covers installed permission and actual publication; Task 3 covers caller-first retirement and remaining inventory. Each review-focus case has a corresponding test or explicit runtime refusal above. No new role or general credential abstraction is proposed.

Preserve BASIC's selected subagent-driven implementation/review method. This plan is ready for human review; approval of the earlier design is recorded separately from approval of this implementation plan.
