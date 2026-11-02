# Install Sandbox site permissions through private Terraform delivery

## Outcome and decision

Install the existing Sandbox site-publishing policy without copying application secrets to a workstation. Add a dedicated `sandbox-site-permissions` operation to the existing GitHub Terraform Plan/Apply pipeline. BASIC selected this approach and approved this written design on October 30.

PR #507 has already merged. Its source changes do not install permissions. No new Sandbox deployment was observed at the last check. The next Sandbox publishing attempt needs this prerequisite first.

The original migration plan assumed a supported local application-input file. None was verified. This amendment replaces that installation route, while preserving its exact-resource review and saved-plan requirements. It does not change the existing meeting-update operation.

## Approaches

| Route                                                        | Tradeoff                                                                                                                  | Decision          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Dedicated protected GitHub operation                         | Reuses the existing secret store and approval controls; needs a small delivery extension and bounded IAM bootstrap update | Selected by BASIC |
| Local operator Terraform with an existing private input file | Avoids workflow changes, but no authoritative application input file was found                                            | Not selected      |

Direct IAM installation and exporting secrets through Actions are outside this design. They would bypass the Terraform ownership or secret-storage boundary that the migration is meant to preserve.

## Operator sequence

1. Review and merge the prerequisite source PR. Coordinate the source change with the current Sandbox operator before either owner creates a plan.
2. Through the existing SSO operator route, prepare a private saved bootstrap Terraform plan that updates only the existing Terraform runner's inline permission policy. Independently review the exact binary and its JSON, apply only those saved bytes, and verify the resulting permissions. Bootstrap inputs belong to the bootstrap root; they never substitute for application inputs.
3. Dispatch Terraform Plan on exact merged `master`, environment/workspace `sandbox`, with scope `sandbox-site-permissions`. Application inputs remain in the existing protected GitHub environment.
4. Retain the saved binary and review material through the existing versioned private capture route. Independently verify the actual plan and exact policy document. Create an Apply consumer only after the producer completes successfully.
5. Use the existing native required-reviewer approval and exact plan/bundle digests. Revalidate the restored plan immediately before Apply, then verify the installed policy and attachment.
6. Coordinate a real Sandbox deployment through the existing deployment path. Separately record the actual OIDC actor and frontend/docs publishing results. Only successful replacement acceptance permits later static-binding cleanup.

Changing source, lockfile, private input bindings, plan bytes or ownership invalidates an earlier plan approval. An active state operation or unknown acknowledgment stops the next mutation until reconciled.

## Application operation

The new scope is valid only for the Sandbox environment and Sandbox workspace. Production, another workspace, reruns and unsupported workflow source refuse through the existing invocation controls.

It targets exactly:

- `aws_iam_policy.site_publishing[0]`
- `aws_iam_role_policy_attachment.site_publishing[0]`

The scope permits the expected policy creation or in-place policy update and attachment creation, or a completed no-op. It refuses deletion, replacement, imports, moves and any other managed-resource change. Dependencies may be read, but their managed resources must remain unchanged. Missing, unknown or malformed policy/identity evidence refuses before capture or Apply.

Validation compares the actual policy with the reviewed source contract: exact Sandbox site buckets and object paths, exact frontend/docs distributions, exact application KMS key and S3 encryption conditions. The attachment must name the existing Sandbox deployment role and that policy. Broad action/resource grants, another role/site/key, trust changes, distributions, tables and application services refuse.

Reuse the existing scoped-plan validation, bundle, private capture and native approval modules. Add the scope at every producer/consumer schema and dispatch boundary, use its two targets during Plan, and revalidate it after bundle restoration during Apply. Keep other scopes unchanged.

## Bootstrap authority

Live read-only inspection confirmed that the existing Terraform runner has the meeting-update prerequisites, but cannot create the site policy or attach it. A workflow-only extension cannot install this prerequisite.

Extend the existing bootstrap-owned runner permission policy with only the metadata reads needed for these targeted resources and the following bounded writes:

- Create/tag or create a new version of the exact Sandbox site policy.
- Attach only that policy to the existing Sandbox deployment role, using both the exact role resource and an exact `iam:PolicyARN` condition.

No administrator grant, new role, trust change, production resource, application data read or policy-version pruning is included. At the managed-policy version limit, stop rather than deleting versions. Inventory any provider-required action before including it; an access denial is evidence to review, not permission to add a wildcard grant.

IAM cannot constrain the contents of a newly created policy document. The exact-plan validator, independently reviewed bytes and native approval are therefore required controls, not optional checks. Use a scope-specific Apply session policy to exclude the runner's unrelated meeting-update writes from this operation. Preserve existing scopes' authentication behavior and prove session-policy size against the STS limit.

The bootstrap update gets its own exact saved-plan validation. Only the runner's existing inline policy may change. Its trust, capture bucket, encryption key, state backend and all application resources remain unchanged. Preserve the original cold-create bootstrap guard; do not weaken it to accept arbitrary updates.

## Scope and source delivery

Expected changes are confined to Terraform Plan/Apply inputs, invocation/dispatch validation, the existing scoped workflow, one focused site-permission validator and tests, the Sandbox bootstrap permission definition and a bounded update-plan check, and their operator documentation. Reuse existing fixtures and validation helpers. Add no general updater, credential broker or new secret.

Use the existing isolated worktree on `codex/sandbox-site-permissions`. Deliver a separate reviewable prerequisite PR. No merge, Apply or deployment is implied by design approval; each actual saved plan and native approval remains separate.

## Verification and completion

- Regression tests cover the allowed policy/attachment changes and no-op, wrong environment/workspace, excess actions/resources, unknown policy values, another role/key/site, deletes/replacements/imports/moves, and unrelated managed changes.
- Workflow tests bind the new scope consistently through Plan, private capture, restoration and Apply revalidation. Existing scopes and approval tests remain green.
- Bootstrap tests prove only the reviewed inline-policy update and reject trust, bucket, key, backend or unrelated changes. Policy tests cover exact grants and the scoped session's STS size.
- Use the repository-pinned Node/Terraform/provider versions, formatter, lint and applicable existing Terraform tests. Required source checks and independent reviews precede PR readiness, including the repository's exact-head 30-minute gate.
- Keep separate receipts for source merge, bootstrap permissions, saved-plan review, installed site permissions, exact OIDC identity and actual publishing. Root keys and stored bindings remain untouched until the migration's later acceptance and cleanup stages.

## Evidence appendix

- Source baseline: `d82317a21da5b25b5c5eb0bdd155039940a4b9af`, merged PR #507, observed October 30.
- Existing delivery controls: `scripts/deployment/terraform-bundle.cjs`, `terraform-dispatch.cjs`, `terraform-workflow.cjs`, `.github/workflows/terraform-plan.yml` and `terraform-apply.yml`.
- Existing bootstrap owner: `_infra/sandbox-bootstrap/terraform-role.tf` and its README/guards.
- Sandbox approval metadata was read: one individual reviewer, self-review permitted, administrator bypass disabled, no branch policy. Private selectors and IAM evidence remain in the owning chat's protected operator record.
