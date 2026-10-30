# Sandbox site-permissions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a protected, narrowly scoped Terraform operation that installs the missing Sandbox site policy without exporting application secrets.

**Architecture:** Extend the existing private Plan/Apply pipeline with one Sandbox-only scope and an exact-policy validator. Extend the bootstrap-owned runner permissions only enough to execute that scope, with a separate update-plan guard. Source delivery precedes independently reviewed bootstrap and application saved plans.

**Tech stack:** Existing GitHub Actions, CommonJS, Jest, Terraform and AWS IAM/S3/KMS.

**Spec:** [Approved design](../specs/2026-10-30-sandbox-site-permissions-design.md).

The user-visible outcome is unchanged Sandbox publishing through the OIDC jobs merged in #507. This PR supplies their missing installation route. BASIC has already selected subagent execution. Written-plan review is pending.

## Global constraints

- The new scope is valid only for the Sandbox environment and Sandbox workspace.
- It targets exactly `aws_iam_policy.site_publishing[0]` and `aws_iam_role_policy_attachment.site_publishing[0]`.
- Keep other scopes unchanged. Preserve the original cold-create bootstrap guard; do not weaken it to accept arbitrary updates.
- No administrator grant, new role, trust change, production resource, application data read or policy-version pruning is included.
- Application inputs remain in the existing protected GitHub environment. Bootstrap inputs belong to the bootstrap root; they never substitute for application inputs.
- Changing source, lockfile, private input bindings, plan bytes or ownership invalidates an earlier plan approval.
- No merge, Apply or deployment is implied by design approval; each actual saved plan and native approval remains separate.
- Root keys and stored bindings remain untouched until the migration's later acceptance and cleanup stages.

## Review focus

- A no-op or empty plan must not bypass policy-content validation. Require both target entries and the known dependency identities, even when no writes remain.
- A newly created policy has computed identifiers. Permit only those output fields and a proven direct attachment reference; unknown actions, policy contents or role identity refuse.
- Bucket overrides and Terraform/deployment distribution selectors must agree. Refuse mismatches before planning or applying, without logging selectors or secrets.
- Adding the new runner grants must not make unrelated meeting-update writes available in the new Apply session. Test the actual generated session policy and its 2,048-byte limit.
- A later Apply must revalidate the restored binary's JSON, current input binding and native approval. Changed source or private binding must refuse before provider mutation.

## Files and responsibilities

| Files                                                                                                                                  | Responsibility                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `scripts/deployment/validate-sandbox-site-permissions-plan.cjs` (new)                                                                  | Scope binding and exact application-policy/attachment validation     |
| `scripts/deployment/terraform-bundle.cjs`, `terraform-dispatch.cjs`, `terraform-workflow.cjs`                                          | Scope schemas, two Plan targets and restored-plan Apply revalidation |
| `.github/workflows/terraform-plan.yml`, `terraform-apply.yml`                                                                          | Dispatch choices and restricted new-scope authentication             |
| `test/scripts/deploymentSandboxSitePermissionsPlan.test.js` (new), `test/fixtures/deployment/sandboxSitePermissionsPlan.js` (new)      | Known/computed/no-op plans and rejected policy/resource changes      |
| Existing `terraformBundle`, `terraformDispatch`, `terraformWorkflow`, `terraformApplySource` tests and workflow fixtures               | Invocation, transport, approval and compatibility regressions        |
| `_infra/sandbox-bootstrap/terraform-role.tf`, `main.tf`, `verify-plan.cjs`, `verify-plan.test.cjs`, existing bootstrap Terraform tests | Exact runner grants and a separate existing-policy update guard      |
| `_infra/README.md`, `_infra/sandbox-bootstrap/README.md`, `docs/terraform-private-delivery.md`                                         | Supported operator sequence and proof boundaries                     |

## Task 1: Sandbox-only application operation

**Consumes:** Existing `prepareSandboxSiteSession(variables, site)`, `validateScopedPlan`, private storage binding, saved bundles and native approval verification.

**Produces:** `sandboxSitePermissionsTargets` (the two-address Map), `sandboxSitePermissionsBinding(storageBinding, githubVariables)`, `prepareSandboxSitePermissionSession(binding) -> {policy, masks}` and `validateSandboxSitePermissionsPlan(plan, binding) -> {result: "accepted", changes}` in the new validator module. The binding carries `environment`, `accountId`, `region`, `kmsKeyArn`, both configured bucket names/distribution IDs and the deployment-role ARN. Reuse existing selector validation; add no secret or generic credential abstraction. Require the known unchanged application key to equal the binding key, rather than inferring that capture and application encryption always share a key.

- [ ] Refresh source and applicable instructions in the isolated branch. Verify pinned toolchain/dependency provenance. Read every invocation-schema, scoped-validator and workflow caller before changing them. Coordinate source/state ownership with the Sandbox owner.
- [ ] Add failing application guard tests. Assert creation, policy-only in-place update and complete validated no-op succeed; empty/missing/duplicate targets, production/workspace mismatch, wrong role/key/site, extra actions/resources/conditions, unknown policy contents, unrelated writes, imports, moves, deletion and replacement throw. Assert KMS policy equality with `_infra/site-publishing.tf`, including exact key and both S3 object contexts. Tests must reject a malformed policy even when its action is `no-op`.
- [ ] Pin the computed-identifier boundary with fixtures: a created policy may have unknown ARN/ID, and attachment policy ARN may be unknown only when its configuration directly references that exact created policy. Unknown attachment role or arbitrary expression fails. Known values must equal the expected ARN. Dependency buckets, application key and deployment role must be present, known and unchanged. Do not exempt aggregate failed checks or drift merely to accept a fixture.
- [ ] Run `node node_modules/jest/bin/jest.js --runInBand --coverage=false --runTestsByPath test/scripts/deploymentSandboxSitePermissionsPlan.test.js` under the pinned Node. Retain the expected RED failures, then implement the focused validator with existing assertion/helpers. Fail with a fixed diagnostic rather than printing plan content.
- [ ] Add failing transport tests: `parseInvocation`/dispatch accept `sandbox-site-permissions` only for Sandbox/Sandbox and reject production/default or unknown modes; Plan passes exactly the two target arguments; validation runs before capture; Apply runs it again after restoration and before mutation. Use existing fake private command/capture fixtures, not real providers. Add selector-mismatch and malformed-variable cases to the boundary tests.
- [ ] Add the new scope to both workflow choices, dispatch/invocation schemas, target/validator registries and Apply revalidation set. Construct the scope binding from the verified private storage binding plus current `GITHUB_VARS_JSON`; require account/region equality and deployment/TFVAR distribution agreement. Reuse the current scope's selectors and protect the binding through the existing saved-source/input checks. Preserve all other scopes' behavior.
- [ ] Configure a compact scope-specific Sandbox Apply session guard using `prepareSandboxSitePermissionSession(binding)` and a `--session` CLI in the same module, masking before `GITHUB_OUTPUT`. The reviewed bootstrap base policy supplies exact allows. Intersect it with an inline allow and explicit denies: deny `dynamodb:UpdateTable` on all resources; deny site-policy create/tag/version writes with `NotResource` naming the exact site-policy ARN; deny `iam:AttachRolePolicy` with `NotResource` naming the exact deployment role. Preserve the base policy's exact attachment `iam:PolicyARN` condition. This removes the two existing meeting-update writes without repeating the long state/capture permissions. Test the session against current base writes and a synthetic exact site-permission fixture; Task 2 adds the completed real bootstrap intersection check. Require at most 2,048 bytes, including longest allowed selectors. Existing scopes' authentication remains unchanged; Plan retains its read-only session.
- [ ] Run the new suite and `terraformBundle.test.js`, `terraformDispatch.test.js`, `terraformWorkflow.test.js`, `terraformApplySource.test.js`, `terraformNative.test.js`, `sandboxSiteSession.test.js` and existing processing-retry guards. Require terminal passes. Run scoped ESLint, formatter and actionlint; report missing tools explicitly. Update the private-delivery/application operator docs, self-review and commit. Obtain the task's independent spec/quality review before Task 2.

## Task 2: Bootstrap runner authority and bounded update guard

**Consumes:** The application operation and its tested session-policy contract. Existing bootstrap `validateBootstrapPlan(plan, binding)` and exact independently reviewed policy hashes remain authoritative for cold creation.

**Produces:** Bounded site-policy permissions in the existing runner policy, plus `validateBootstrapSitePermissionsUpdate(plan, binding)` exported from the existing bootstrap guard. CLI form: `node _infra/sandbox-bootstrap/verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON --site-permissions-update`. The existing two-argument cold-create CLI remains unchanged. The update binding adds an independently observed `previousRolePolicySha256` to the existing reviewed binding; unknown modes or binding fields refuse.

- [ ] Inventory the exact AWS-provider read/write actions required by the two application targets and their dependency reads. Bind grants to the two configured Sandbox buckets, exact existing application key, exact deployment role, exact site-policy ARN and existing OIDC-provider metadata if needed. Add non-secret bootstrap variables `site_frontend_bucket` and `site_docs_bucket`, default empty and required/validated when the Terraform role is enabled; their reviewed values must match the existing deployment selectors. Update the strict complete-variable binding, every bootstrap fixture/caller and documentation for these two fields. Keep trust, backend and encryption inputs unchanged. Record action reasons in the bootstrap README. Do not treat an observed denial as approval for wildcard expansion.
- [ ] Add failing permission tests and bootstrap mock-plan assertions. Require only exact site-policy create/tag/version permissions, metadata reads and `iam:AttachRolePolicy` on the deployment role with an exact `iam:PolicyARN` condition. Assert no new trust, administrator grant, production/data authority, detach/delete-policy or version-pruning grant. Prove the role policy fits the IAM 10,240-byte inline-policy size limit.
- [ ] Add failing update-guard fixtures. Only `aws_iam_role_policy.sandbox_terraform[0]` may update, or be a fully validated no-op. Its before policy must match the independently reviewed installed-policy hash and its after policy the exact reviewed source contract. Refuse unrelated field changes, trust/storage/backend/key changes, missing or wrong inputs, unknown required fields, drift, imports/moves and other managed changes. Preserve the original cold-create rejection tests.
- [ ] Run `node --test _infra/sandbox-bootstrap/verify-plan.test.cjs` and retain expected RED results. Implement the minimum bounded grants and update mode using the guard's existing binding/policy comparison helpers. Keep the bootstrap backend and trust inputs unchanged. Reject at five managed-policy versions rather than introducing automatic pruning.
- [ ] Evaluate Task 1's session guard against the actual completed bootstrap role-policy document. Require all old runtime-policy versioning and table writes denied, exact site/state/lock/capture operations retained, no additional allowed application write, and the exact attachment condition. Assert the complete write inventory so a future base-policy expansion cannot silently weaken this operation.
- [ ] Run that Node suite and the existing bootstrap Terraform tests with their exact pinned Terraform/provider versions: `terraform -chdir=_infra/sandbox-bootstrap init -backend=false -input=false -lockfile=readonly`, then `terraform -chdir=_infra/sandbox-bootstrap test`. Run the application `site-publishing.tftest.hcl` mock test with the application root's own pinned toolchain. No remote backend initialization or provider mutations belong in these source tests.
- [ ] Update bootstrap/application/private-delivery docs with the separate saved-plan sequence, source invalidation rules and stop conditions. Run formatter on every branch-changed file, including spec/plan, plus scoped lint, Terraform format checks and actionlint. Self-review and commit. Obtain independent task review and then the required whole-branch review. Publish a PR against current `master`, attach it to the owning chat, and iterate feedback through the exact-head 30-minute gate. Do not merge or claim installation from source checks.

## Operator rollout after source delivery

This sequence completes the installation goal after the source PR is merged. It is not permission to skip any actual saved-plan review or native approval. Keep private inputs and receipts outside public source.

1. Refresh account-admin SSO identity, exact merged source/lock hashes, current IAM, both backend/workspace identities and the Sandbox owner's exclusion window. Verify the authoritative protected bootstrap inputs; if unavailable, stop this stage rather than reconstructing unknown values or using application tfvars.
2. Save a bootstrap plan targeting only `aws_iam_role_policy.sandbox_terraform[0]`, render JSON privately, verify it with the new update guard and independently review the actual saved binary, input/source fingerprints and before/after policy bytes. Apply only those approved bytes. Verify the installed runner policy and unchanged trust/storage. Retain the exact receipt.
3. Dispatch the new application Plan from merged `master`, using the existing protected Sandbox inputs. Require successful private capture and independently inspect the actual binary/JSON, exact two-address delta and complete validated dependencies. Refuse policy-version exhaustion, unknown acknowledgment, source/binding drift or conflicting owner activity.
4. Create and approve the native Apply consumer for those exact plan/bundle digests. Recheck approval and binding immediately before mutation. Verify the installed site policy document and deployment-role attachment afterward; distinguish failed, unknown and completed results.
5. Coordinate the existing Sandbox deployment. Verify actual OIDC actor and frontend/docs publishing/readiness, including the appropriate enabled/disabled docs behavior. No production deployment is included. Retain source, bootstrap authority, installed policy and hosted operation evidence separately.
6. Update the private root-consumer/lifecycle receipt. Resume the earlier migration plan's fresh caller inventory and binding retirement only after successful replacement acceptance. Both root keys remain active throughout this slice.

## Plan review

Self-review maps application validation and all five review-focus cases to Task 1, runner/bootstrap restrictions to Task 2, and live acceptance to the ordered rollout gates. Existing permissions, private capture and native approval modules are reused. No new dependency, secret, role or general updater is proposed.

The design is approved. This implementation plan awaits BASIC's review before the preserved subagent workflow begins.
