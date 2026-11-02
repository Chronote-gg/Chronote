# Sandbox Terraform bootstrap

This separate root creates a private evidence bucket and one OIDC execution role for the Sandbox `meeting-update-delivery` and `sandbox-site-permissions` scopes. Both enable flags default to false. Enabling both creates exactly eight resources. The application root and production bootstrap remain separately owned.

Use Terraform 1.16.0 and the checked AWS 6.69.1 lock. The backend has its own fixed key, `meeting-notes-terraform/sandbox-bootstrap/state`, and workspace prefix. Bootstrap uses only the default workspace. Never override its backend, import application resources, or migrate application state.

## Private inputs

Supply a protected JSON variable file outside the repository containing every input below:

- `enable_private_evidence_store` and `enable_sandbox_terraform_role`, both true for installation.
- `environment` equal to `sandbox` and `aws_region` equal to `us-east-1`.
- `sandbox_account_id`, the reviewed account.
- `kms_key_arn`, the existing enabled same-account regional key.
- `site_frontend_bucket` and `site_docs_bucket`, the exact existing names from the Sandbox deployment selectors. Both default empty and are required when enabling the role. These are non-secret bootstrap inputs, never application tfvars.
- `administrator_role_arn`, the existing native bootstrap maintainer.
- `reviewer_role_arn`, the existing private exact-version reader.
- `github_repository_id` and `github_owner_id`, independently verified numeric identities.
- `trusted_refs`, exactly `refs/heads/codex/sandbox-terraform-capture` and `refs/heads/master`.

Select the existing SSO administrator as maintainer when using the native SSO route. Administrator and reader may differ. Neither may be the executor or either runtime role. This root adds no identity policies to those existing principals and creates no key. Its GitHub provider lookup reads the existing shared provider; never import, manage, or change that provider.

The bucket has versioning, owner enforcement, all public access blocks, one exact SSE-KMS key, and disabled bucket keys. There is no expiration lifecycle. Conditional writes require `If-None-Match: *` and exact encryption headers. Bucket denials prevent executor and reader administration, deletion and latest-object reads. The reader can discover versions only under `terraform/sandbox/`. All eight resources prevent destruction.

## Execution permissions

The base role reads metadata for exactly 30 Sandbox tables, the runtime managed IAM policy, and the existing KMS key. It has no runtime row or object-body reads. For meeting delivery, its application writes are `UpdateTable` on MeetingHistoryTable and `CreatePolicyVersion` on the runtime policy. Site installation also permits create/tag/version on only the exact Sandbox site policy and attachment to only the exact deployment role with an exact `iam:PolicyARN` condition. IAM cannot restrict their contents; the application saved-plan guard enforces the exact index and DescribeTable delta.

The role can access only the existing Sandbox application state object and the two exact backend lock keys. State uses AES256 and receives no guessed KMS grants. Workspace discovery can list only the two documented metadata prefixes. Evidence crypto requires regional S3 service, caller account and exact object encryption context.

Plan uses the restrictive inline session policy in `terraform-plan.yml`, intersected with this base role. The site-permissions scope selects a separate credential step with only the two additional inventoried bucket reads, `s3:GetAccelerateConfiguration` and `s3:GetReplicationConfiguration`. Legacy scopes keep their exact previous session policy. The tests read that actual policy, check its STS size and prove application writes and state writes are excluded. Apply retains the existing private saved-plan and native approval checks. Either targeted managed policy must have fewer than five versions before its update; stop at five. This role cannot prune versions.

## Site action inventory

The application root locks AWS provider 6.70.0. The bootstrap root separately locks
6.69.1. Their offline checks use their own locks. The targeted application graph
must contain only the two site targets, two buckets, existing application key,
existing deployment role and its identity metadata. Distribution IDs are inputs,
so this operation needs no CloudFront grant.

| Provider operation                                   | IAM actions and reason                                                                                                                                                                                                                                                                                                                                                                              | Exact scope                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Site policy create/update/read                       | `iam:CreatePolicy`, `iam:TagPolicy`, `iam:CreatePolicyVersion`, `iam:GetPolicy`, `iam:GetPolicyVersion`, `iam:ListPolicyVersions`, `iam:ListPolicyTags`                                                                                                                                                                                                                                             | `meeting-notes-sandbox-site-publishing` policy ARN                                                          |
| Attachment create/read                               | `iam:AttachRolePolicy`, `iam:ListAttachedRolePolicies`                                                                                                                                                                                                                                                                                                                                              | Existing `meeting-notes-sandbox-github-deploy` role; attachment additionally requires exact `iam:PolicyARN` |
| Deployment role refresh                              | `iam:GetRole`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`                                                                                                                                                                                                                                                                                                          | Same deployment role only                                                                                   |
| GitHub provider refresh                              | `iam:GetOpenIDConnectProvider`                                                                                                                                                                                                                                                                                                                                                                      | Existing same-account `token.actions.githubusercontent.com` provider ARN                                    |
| Bucket refresh, including deprecated inline controls | `s3:ListBucket` for HeadBucket; `s3:GetBucketPolicy`, `s3:GetBucketAcl`, `s3:GetBucketCORS`, `s3:GetBucketWebsite`, `s3:GetBucketVersioning`, `s3:GetAccelerateConfiguration`, `s3:GetBucketRequestPayment`, `s3:GetBucketLogging`, `s3:GetLifecycleConfiguration`, `s3:GetReplicationConfiguration`, `s3:GetEncryptionConfiguration`, `s3:GetBucketObjectLockConfiguration`, `s3:GetBucketTagging` | Only the two reviewed bucket ARNs, no objects                                                               |
| Application key refresh                              | Existing `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:GetKeyRotationStatus`, `kms:ListResourceTags`                                                                                                                                                                                                                                                                                                  | Existing exact application key, unchanged                                                                   |

Provider evidence is pinned to the application lock: [policy resource](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/policy.go),
[tag handling](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/tags.go),
[role resource](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/role.go),
[attachment](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/role_policy_attachment.go),
[OIDC lookup](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/openid_connect_provider_data_source.go),
[bucket resource](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/s3/bucket.go),
and [key refresh](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/kms/key.go).
`GetRole` and `GetOpenIDConnectProvider` return tags directly. Policy tags need a
separate list read; create-with-default-tags requires `TagPolicy` authority.
Updates retain the four reviewed default tags. Tag removal, delayed default-version
selection, detach, deletion and version pruning are not permitted.

The source lookup uses the exact OIDC ARN instead of account-wide provider
discovery. Routing checks use the exact HTTPS listener count predicate without
reading the listener resource. Neither change alters a trust document or manages
an OIDC provider. A broader actual graph or an access denial stops the operation;
it does not authorize extra grants. The complete inline policy must fit IAM's
10,240-byte shared role limit, including any other inline policies observed by the
operator. The tests prove this source document fits; installation inventory is
still required.

## Saved bootstrap plan guard

```sh
node _infra/sandbox-bootstrap/verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON
```

The strict reviewed binding has `backendKey`, a complete `variables` map, and `policySha256` with `bucket`, `trust`, and `role` hashes of the exact independently reviewed policy strings. The guard accepts only eight creates plus the three approved existing metadata lookups. It rejects imports, moves, extra effects, drift, incomplete plans, unknown required controls, changed identities, foreign providers and changed policy contracts.

Review policy bytes independently before recording hashes. Do not derive approval from an unreviewed plan. The JSON guard does not prove backend selection, source checkout, human approval or that JSON came from the binary being applied. The private native operator packet binds those separately.

## Bounded existing-policy update

```sh
node _infra/sandbox-bootstrap/verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON --site-permissions-update
```

This separate mode accepts only an in-place update of
`aws_iam_role_policy.sandbox_terraform[0]`, or its fully validated no-op. Other
managed entries may only be unchanged reviewed bootstrap resources. The binding
has exactly the cold-create fields plus `previousRolePolicySha256`, the independently
observed installed inline-policy string hash. Its `policySha256.role` must identify
the independently reviewed new source policy bytes. Unknown binding fields refuse.
Before/after differences outside `policy`, unknown update values, trust/storage/key
changes, drift, imports, moves and unrelated writes refuse. The existing role's
provider-refreshed inline-policy field may contain only that one named policy,
with bytes matching the independently observed previous hash. The cold-create
mode still requires exactly eight creates and refuses update bindings.

1. Coordinate the Sandbox owner's exclusion window. Verify the account-admin SSO
   identity, merged source and lock hashes, default bootstrap workspace, fixed
   bootstrap backend and authoritative protected bootstrap inputs. Confirm the two
   bucket inputs equal the existing deployment selectors. Stop if any input is
   unavailable; never reconstruct it from application tfvars.
2. Observe installed inline-policy bytes independently, record their previous hash,
   and inspect all other inline policies for the shared size limit. Save a bootstrap
   plan targeting only the existing inline-policy address. Render JSON privately,
   run update mode, and independently review the actual binary, source/input
   fingerprints and before/after bytes. Apply only separately approved saved bytes.
3. Verify installed policy and unchanged role trust, capture bucket, encryption and
   backend. Retain this receipt separately. A source check or successful guard is
   not installation proof.
4. Only then use merged `master` for the application `sandbox-site-permissions`
   Plan, private capture, exact binary/JSON review, native Apply approval and
   post-Apply policy/attachment readback. Check the site policy's version count
   immediately before an update and stop at five. Never grant pruning.
5. Coordinate deployment and verify actual OIDC identity and site publishing.
   Retain these receipts separately from source and installation. Both root keys
   and existing bindings remain active until later replacement acceptance.

Changed source, locks, selectors, private bindings or saved bytes invalidate review
and require a new plan. Conflicting owner activity or unknown acknowledgment stops
the next mutation until reconciled. This procedure does not authorize a live Apply.

## Offline verification

```sh
terraform -chdir=_infra/sandbox-bootstrap init -backend=false -input=false -lockfile=readonly
terraform -chdir=_infra/sandbox-bootstrap fmt -check -recursive
terraform -chdir=_infra/sandbox-bootstrap validate -no-color
terraform -chdir=_infra/sandbox-bootstrap test -no-color -filter=tests/bootstrap.tftest.hcl
terraform -chdir=_infra/sandbox-bootstrap test -no-color -json -verbose -filter=tests/guard-plan.tftest.hcl > "$PRIVATE_DIRECTORY/mock-raw.jsonl"
node _infra/sandbox-bootstrap/compact-mock-plan.cjs "$PRIVATE_DIRECTORY/mock-raw.jsonl" > "$PRIVATE_DIRECTORY/mock.jsonl"
SANDBOX_BOOTSTRAP_MOCK_PLAN_JSONL="$PRIVATE_DIRECTORY/mock.jsonl" node --test _infra/sandbox-bootstrap/verify-plan.test.cjs
```

For native application target-graph verification, capture `terraform -chdir=_infra test -json -verbose -filter=tests/site-publishing.tftest.hcl` privately and pass its JSONL path as `SANDBOX_SITE_MOCK_PLAN_JSONL` to the same Node test command. The test requires exactly the six managed addresses and refuses an ALB/VPC dependency. On Windows use backslashes in the test-file filter.

These are synthetic mocked-provider checks. The integration test combines the actual mock changes with a fixed reviewed synthetic envelope and policy hashes. It does not create an applyable saved binary or prove native installation.

Actual installation, OIDC claim acceptance, capture/readback, individual approval, scoped Plan/Apply, deployment and hosted acceptance remain separate native checks. Use the existing authenticated workstation route and protected files. Do not bridge credentials into a cloud sandbox.
