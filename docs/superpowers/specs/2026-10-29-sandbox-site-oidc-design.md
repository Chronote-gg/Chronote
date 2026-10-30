# Sandbox site publishing through OIDC

## Approved outcome

Move the Sandbox frontend and docs deployment jobs from static AWS keys to the existing Sandbox GitHub OIDC deployment role. Keep deployment approval, concurrency, target selection, optional docs behavior and asset caching intact. BASIC approved this migration design on October 29.

Reuse the existing site-publishing managed policy and attachment in `_infra/site-publishing.tf`. Do not add a role or broaden trust. The role gains the site policy across its sessions; restrict each publishing job further to its own configured bucket, distribution and S3 encryption context. Separate publisher roles are unnecessary for this slice.

## Required behavior

- Each site job requests `contents: read` and `id-token: write`, uses `vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN` and `vars.AWS_ACCOUNT_ID`, obtains a one-hour session and verifies the exact Sandbox assumed-role/session before provider operations.
- Frontend sessions may list their bucket, publish/delete its objects, abort multipart uploads and invalidate their distribution. Docs additionally retain their distribution and invalidation reads. KMS use stays constrained to S3 and that site's object context, intersected with the role's installed exact-key policy.
- Validate selectors before expanding the session policy. Preserve valid bucket overrides; reject malformed buckets/distributions, wrong identities and unresolved policy variables. Mask private selectors and policy values before Actions can echo them. Do not reuse the production-only private-capture parser for Sandbox or change production behavior.
- Preflight requires the existing account and role selectors instead of static credentials. Preserve production-target rejection and all existing deployment gates.
- Install only the existing Sandbox site policy and attachment through a reviewed saved Terraform plan and the supported operator route. The restricted meeting-update-delivery workflow remains unchanged. Refuse unrelated resources, private-binding uncertainty, concurrent-owner conflicts or permission failures.
- Source merge, installed policy, fresh OIDC authentication and actual publishing each need separate acceptance evidence. Never fall back to root or static credentials.
- Remove obsolete GitHub bindings and the Terraform key-variable producer only after all static callers are migrated and the replacement succeeds. Inspect all callers, tests and state implications first; do not let a later Terraform apply recreate a retired binding.

## Boundaries

No root-key deactivation or deletion, production application deployment, customer-data reads or unrelated authority expansion. Keep operator bindings, account/resource identifiers, credential values and detailed acceptance receipts outside public source. Keep cached local clients, other-account cloud bindings and the unidentified second root key unresolved until separately verified.

The full private root-consumer inventory and local SSO migration receipt remain with the owning Harness Improvements chat. This source document describes only the Chronote implementation slice.
