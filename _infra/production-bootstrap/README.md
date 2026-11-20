# Production bootstrap

This separate Terraform root owns the private evidence bucket and the two production Terraform OIDC roles: the Apply role `meeting-notes-prod-github-terraform` and the read-only Plan role `meeting-notes-prod-github-terraform-plan`. An administrator plans and applies it locally; the GitHub workflows never touch it, and the role is denied writing its state.

Both flags default to false. With `enable_private_evidence_store` and `enable_production_terraform_role` set it declares:

- six `private_evidence` S3 resources (bucket, public access block, ownership, versioning, encryption, policy);
- `aws_iam_role.production_terraform`, the Apply role, whose trust allows only the `Terraform Apply` workflow, as `repo:Chronote-gg/Chronote:environment:production-terraform` on `refs/heads/master` with both immutable GitHub IDs, for one hour;
- `aws_iam_role_policy.production_terraform`, the inline policy, which holds only denies;
- the AWS managed `ReadOnlyAccess` attachment and the managed write policy `meeting-notes-prod-terraform-delivery` with its attachment.
- the Plan role `aws_iam_role.production_terraform_plan`, trusting only the `Terraform Plan` workflow in `production` on `master`, with `ReadOnlyAccess` and an inline policy for the state lock and secret reads, denied customer data.

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

### Dedicated Production Plan environment

Production Plan uses the existing protected environment until the migration is enabled. Keep Production Apply on its existing protected environment.

1. Create GitHub environment `production-plan` with a custom deployment branch policy for exact `master` and no required reviewers. Leave the existing environments and their protections in place.
2. Provision this environment’s Plan-role ARN, AWS account and region, matching `TFVAR_*` variables, and Plan secrets from the authoritative deployment configuration. The Plan workflow needs `TERRAFORM_TFVARS_JSON` and the optional Redis inputs when configured. Existing GitHub secret values are write-only. Use the owner’s authorized source and supply values without logging them.
3. Review and apply this separate production-bootstrap root with `use_dedicated_production_plan_environment = true`. The expected infrastructure change is the existing Plan role’s environment trust subject. This administrative bootstrap Apply requires separate approval. The application’s protected Terraform Apply cannot write bootstrap state.
4. Set the repository Actions variable `USE_DEDICATED_PRODUCTION_PLAN_ENVIRONMENT` to `true`. Run the native Production Plan on `master` and verify its role, retention, saved-plan digest and absence of the reviewer gate. Use the existing native Production Apply review for any subsequent mutation.
5. To restore the old route, revert the opt-in variable and reapply the previous Plan trust subject through the same reviewed bootstrap path. Plan can pause briefly between trust installation and toggling the repository variable.
