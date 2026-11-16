# Production bootstrap

This separate Terraform root owns the private evidence bucket and the production Terraform OIDC role `meeting-notes-prod-github-terraform` with its permissions. An administrator plans and applies it locally; the GitHub workflows never touch it, and the role is denied writing its state.

Both flags default to false. With `enable_private_evidence_store` and `enable_production_terraform_role` set it declares:

- six `private_evidence` S3 resources (bucket, public access block, ownership, versioning, encryption, policy);
- `aws_iam_role.production_terraform`, whose trust allows only the `Terraform Plan` and `Terraform Apply` workflows, as `repo:Chronote-gg/Chronote:environment:production` on `refs/heads/master` with both immutable GitHub IDs, for one hour;
- `aws_iam_role_policy.production_terraform`, the inline policy, which holds only denies;
- the AWS managed `ReadOnlyAccess` attachment and the managed write policy `meeting-notes-prod-terraform-delivery` with its attachment.

The bucket resources, the role and the inline policy have `prevent_destroy` and must keep their addresses. Keep both flags enabled once provisioned. What the role may and may not do is in [Terraform delivery](../../docs/terraform-delivery.md#what-the-production-role-may-do), together with the migration steps.

The S3 backend key is `meeting-notes-terraform/production-bootstrap/state` in the existing state bucket and lock table. Only the default workspace is accepted. Inputs (account, KMS key, administrator and reviewer roles, GitHub repository and owner IDs) stay in a private tfvars file, never in this repository.

## Checks

```sh
terraform -chdir=_infra/production-bootstrap init -backend=false -input=false
terraform -chdir=_infra/production-bootstrap fmt -check -recursive
terraform -chdir=_infra/production-bootstrap validate
terraform -chdir=_infra/production-bootstrap test
```

The tests use mocked providers and synthetic identities. They check the trust, the evidence bucket controls, the resource addresses, both policy size limits, that IAM writes never use a wildcard resource, and the deny statements. `ci-core.yml` runs them with Terraform 1.16.0.
