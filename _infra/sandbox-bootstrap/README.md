# Sandbox Terraform bootstrap

This separate root creates a private evidence bucket and one OIDC execution role for the Sandbox `meeting-update-delivery` scope. Both enable flags default to false. Enabling both creates exactly eight resources. The application root and production bootstrap remain separately owned.

Use Terraform 1.16.0 and the checked AWS 6.69.1 lock. The backend has its own fixed key, `meeting-notes-terraform/sandbox-bootstrap/state`, and workspace prefix. Bootstrap uses only the default workspace. Never override its backend, import application resources, or migrate application state.

## Private inputs

Supply a protected JSON variable file outside the repository containing every input below:

- `enable_private_evidence_store` and `enable_sandbox_terraform_role`, both true for installation.
- `environment` equal to `sandbox` and `aws_region` equal to `us-east-1`.
- `sandbox_account_id`, the reviewed account.
- `kms_key_arn`, the existing enabled same-account regional key.
- `administrator_role_arn`, the existing native bootstrap maintainer.
- `reviewer_role_arn`, the existing private exact-version reader.
- `github_repository_id` and `github_owner_id`, independently verified numeric identities.
- `trusted_refs`, exactly `refs/heads/codex/sandbox-terraform-capture` and `refs/heads/master`.

Select the existing SSO administrator as maintainer when using the native SSO route. Administrator and reader may differ. Neither may be the executor or either runtime role. This root adds no identity policies to those existing principals and creates no key. Its GitHub provider lookup reads the existing shared provider; never import, manage, or change that provider.

The bucket has versioning, owner enforcement, all public access blocks, one exact SSE-KMS key, and disabled bucket keys. There is no expiration lifecycle. Conditional writes require `If-None-Match: *` and exact encryption headers. Bucket denials prevent executor and reader administration, deletion and latest-object reads. The reader can discover versions only under `terraform/sandbox/`. All eight resources prevent destruction.

## Execution permissions

The base role reads metadata for exactly 30 Sandbox tables, the runtime managed IAM policy, and the existing KMS key. It has no runtime row or object-body reads. Its only application writes are `UpdateTable` on MeetingHistoryTable and `CreatePolicyVersion` on the runtime policy. IAM cannot restrict their contents; the application saved-plan guard enforces the exact index and DescribeTable delta.

The role can access only the existing Sandbox application state object and the two exact backend lock keys. State uses AES256 and receives no guessed KMS grants. Workspace discovery can list only the two documented metadata prefixes. Evidence crypto requires regional S3 service, caller account and exact object encryption context.

Plan uses the restrictive inline session policy already in `terraform-plan.yml`, intersected with this base role. The tests read that actual policy, check its STS size and prove application writes and state writes are excluded. Apply retains the existing private saved-plan and native approval checks. The runtime policy must have fewer than five versions before Apply; stop at five. This role cannot prune versions.

## Saved bootstrap plan guard

```sh
node _infra/sandbox-bootstrap/verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON
```

The strict reviewed binding has `backendKey`, a complete `variables` map, and `policySha256` with `bucket`, `trust`, and `role` hashes of the exact independently reviewed policy strings. The guard accepts only eight creates plus the three approved existing metadata lookups. It rejects imports, moves, extra effects, drift, incomplete plans, unknown required controls, changed identities, foreign providers and changed policy contracts.

Review policy bytes independently before recording hashes. Do not derive approval from an unreviewed plan. The JSON guard does not prove backend selection, source checkout, human approval or that JSON came from the binary being applied. The private native operator packet binds those separately.

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

These are synthetic mocked-provider checks. The integration test combines the actual mock changes with a fixed reviewed synthetic envelope and policy hashes. It does not create an applyable saved binary or prove native installation.

Actual installation, OIDC claim acceptance, capture/readback, individual approval, scoped Plan/Apply, deployment and hosted acceptance remain separate native checks. Use the existing authenticated workstation route and protected files. Do not bridge credentials into a cloud sandbox.
