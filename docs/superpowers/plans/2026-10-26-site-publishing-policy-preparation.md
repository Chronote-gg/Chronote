# Site Publishing Policy Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track the steps below.

**Goal:** Prepare narrowly scoped site publishing permissions without changing live credentials or deployment behavior.

**Architecture:** Attach a separate site managed policy to the existing deployment role in each supported environment. Preserve every existing role, inline policy, workflow and the A activation refusal.

**Tech Stack:** Terraform and native mocked-provider tests; existing repository validation tools.

**Spec:** [Site publishing policy design](../specs/2026-10-26-site-publishing-policy-preparation-design.md).

## Global constraints

- Source-only preparation. No AWS account calls, state access, Apply, deployment, credential mutation, customer content or paid generation.
- Reuse the existing `production_deploy` and `sandbox_deploy` roles. Preserve seven-role A inventory and all old source files except the two plan documents.
- No workflows, bootstrap module, paused-draft code, dependency changes, abstractions or cleanup.
- Preserve A's static-route refusal and every later execution gate.

## Review focus

- A future role session gets the whole grant: prove exact site-only resources and actions, not merely policy statement names.
- S3 Bucket Keys are disabled: object encryption context must not widen to bucket roots or recording storage.
- Production and Sandbox share policy source but must select different existing role/resource identities.
- CloudFront preflight and waiter need only the docs distribution; invalidation covers both sites.
- A successful mocked plan proves source shape, not actual installation or publishing success.

## Task 1: Policy and native regressions

**Files:** Create `_infra/site-publishing.tf` and `_infra/tests/site-publishing.tftest.hcl`.

**Interfaces:** Existing Terraform `var.environment`, `var.aws_region`, caller-account data, `local.name_prefix`, site bucket/distribution resources, `app_general` key and existing deployment roles. Produce `aws_iam_policy.site_publishing` and its matching role attachment, with no new input or output.

- [ ] Write mocked-provider assertions for the design's exact policy and attachment contracts in production and Sandbox, with distinct explicit resource fixtures. Include unsupported-environment absence and quota/resource/action/KMS negative controls.
- [ ] Run the tests before implementation and retain the actual missing-feature failure. Distinguish it from provider/setup failures or real IAM denial proof.
- [ ] Implement only the two named Terraform resources with the design's five permission groups. Preserve current upload direction and reject speculative extra permissions.
- [ ] Run the new native tests and existing production/Sandbox deployment-permission tests, then backend-free validation and formatting. All providers must be mocked and metadata disabled.
- [ ] Verify every pre-existing infrastructure/workflow/lock file is unchanged; inspect the complete actual policy JSON and managed-policy size.
- [ ] Run the normal strict quality gate or establish exact eligible-input, policy and pinned-tool invariance for Terraform/Markdown-only changes. Do not invent a fresh scan. Run relevant lint/Markdown/format checks.
- [ ] Freeze the source and commit normally with hooks after independent scoped review. Report exact source, commands, RED/GREEN evidence and limits.

## Task 2: Reviewable source delivery

- [ ] Review the complete small branch, including the permission tradeoff and all test fixtures. Resolve confirmed findings without expanding into workflow or Terraform identity migration.
- [ ] Publish a reviewable PR through the normal source route. Inspect current-head CI and every feedback surface, then perform the repository's final post-30-minute refresh before any merge-ready claim.
- [ ] Hand off the exact source and policy scope to the existing activation owner. Actual installation, credential migration and A compatibility remain separate; do not merge or execute production.

Cleanup and simplification are deferred at BASIC's request.
