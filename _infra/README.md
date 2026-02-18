# Infrastructure Notes

## Observability (AMP + AMG)

This stack provisions:

- Amazon Managed Prometheus (AMP) workspace
- Amazon Managed Grafana (AMG) workspace
- (Optional) Grafana datasource + starter dashboard via the Grafana provider

### Prerequisites

- **AWS Organizations enabled** (single-account org is fine)
- **IAM Identity Center (AWS SSO)** enabled in the **same region** as AMG (us-east-1 here)

### Bootstrap steps (Grafana service account token)

1. **First apply** (creates AMP + AMG):
   - Leave `grafana_api_key` and `grafana_url` empty in `terraform.tfvars`.
   - Run: `terraform apply`

2. **Create a Grafana service account + token** (preferred):
   - Open the Grafana workspace URL.
   - In Grafana: _Administration → Service accounts_ → **New service account** (role: Admin).
   - Create a **token** and copy it.
   - Copy the workspace **endpoint URL** (e.g., `https://g-xxxx.grafana-workspace.us-east-1.amazonaws.com/`).

3. **Second apply** (provisions datasource + dashboard):
   - Set either in `terraform.tfvars` or env vars:
     - `grafana_api_key` (service account token)
     - `grafana_url`
   - Then run: `terraform apply`

### Useful tips

- If AMG workspace creation conflicts, bump `grafana_suffix_seed` in `terraform.tfvars` to force a new workspace name suffix.
- If you change the workspace name, you may want to update `grafana_url` before the second apply.

## Secrets Manager (ECS runtime secrets)

Terraform now creates the Secrets Manager entries and wires them into the ECS task
definition. You must set the secret values after the first apply.

1. Apply Terraform as usual: `terraform apply`
2. In AWS Secrets Manager, set **SecretString** values for:

- `${project_name}-${environment}/discord-bot-token`
- `${project_name}-${environment}/discord-client-secret`
- `${project_name}-${environment}/oauth-secret`
- `${project_name}-${environment}/openai-api-key`
- `${project_name}-${environment}/langfuse-public-key`
- `${project_name}-${environment}/langfuse-secret-key`
- `${project_name}-${environment}/stripe-secret-key`
- `${project_name}-${environment}/stripe-webhook-secret`

1. Redeploy the ECS service (or force a new deployment) so tasks pick up the new secrets.

Notes:

- These secrets should **not** live in `terraform.tfvars`.
- Local development still uses `.env` values.
- Each secret must have an `AWSCURRENT` value. If a secret exists without a value, set **SecretString** to create one.

Example CLI:

```bash
aws secretsmanager put-secret-value --secret-id ${project_name}-${environment}/langfuse-public-key --secret-string "lf_public_..."
aws secretsmanager put-secret-value --secret-id ${project_name}-${environment}/langfuse-secret-key --secret-string "lf_secret_..."
```

## API domain (ALB)

If you set `API_DOMAIN` in `terraform.tfvars`, Terraform will:

- Create an internet-facing ALB for the API (HTTP/HTTPS listeners).
- Create/validate an ACM certificate if `API_CERT_ARN` is not provided and `HOSTED_ZONE_NAME` is set.
- Create a Route53 alias for `API_DOMAIN`.

Recommended OAuth callback for production:

- `https://api.<your-domain>/auth/discord/callback`

The frontend build uses `VITE_API_BASE_URL` (set as a GitHub Actions env var) to
target the API domain.

## Docs domain (CloudFront)

If you set `DOCS_DOMAIN` in `terraform.tfvars`, Terraform will:

- Create or validate an ACM certificate if `DOCS_CERT_ARN` is not provided and `HOSTED_ZONE_NAME` is set.
- Create a Route53 alias for `DOCS_DOMAIN`.
- Provision a dedicated docs S3 bucket + CloudFront distribution and publish GitHub Actions env vars:
  - `DOCS_BUCKET`
  - `DOCS_DISTRIBUTION_ID`
  - `DOCS_SITE_URL` (when set)
  - `DOCS_ALGOLIA_APP_ID` (when set)
  - `DOCS_ALGOLIA_API_KEY` (when set)
  - `DOCS_ALGOLIA_INDEX_NAME` (when set)

Deploy workflows use those variables to publish `apps/docs-site` to `docs.chronote.gg`.

## Environments (prod vs staging)

Terraform now supports environment-specific resource naming via `environment`
and `project_name` in `terraform.tfvars`.

Recommended workflow:

1. Use a separate workspace for staging: `terraform workspace new staging`
2. Set `environment="staging"` and `github_environment="staging"` in
   `terraform.tfvars` for staging runs.
3. For production, keep `environment="prod"` and your existing GitHub Actions
   environment name (currently `sandbox`).

If you prefer separate variable files, use:

- Prod: `terraform -chdir=_infra plan -var-file=terraform.tfvars`
- Staging: copy `terraform.staging.tfvars.example` to `terraform.staging.tfvars`, then run
  `terraform -chdir=_infra plan -var-file=terraform.staging.tfvars`
