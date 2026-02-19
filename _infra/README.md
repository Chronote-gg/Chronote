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

2. **Create a Grafana service account + token**:
   - Open the Grafana workspace URL.
   - In Grafana: _Administration > Service accounts_ > **New service account** (role: Admin).
   - Create a **token** and copy it.
   - Note the service account numeric ID (or run
     `aws grafana list-workspace-service-accounts --workspace-id <id> --region us-east-1`).
   - Copy the workspace **endpoint URL** (e.g., `https://g-xxxx.grafana-workspace.us-east-1.amazonaws.com/`).

3. **Second apply** (provisions datasource + dashboard + rotation infra):
   - Set in `terraform.tfvars`:
     - `grafana_api_key` (the manual token for bootstrapping)
     - `grafana_url`
     - `grafana_service_account_id` (numeric ID from step 2)
   - Run: `terraform apply`

4. **Seed the rotation** (one-time):
   - Invoke the Lambda to create the first auto-managed token:
     ```bash
     aws lambda invoke --function-name <project_name>-<environment>-grafana-token-rotation \
       --region us-east-1 /dev/stdout
     ```
   - The function name is derived from your Terraform variables (for example, with
     `project_name = "meeting-notes"` and `environment = "prod"`, the name is
     `meeting-notes-prod-grafana-token-rotation`).
   - Clear `grafana_api_key` from `terraform.tfvars` (the Lambda now manages the token).
   - Run `terraform apply` once more to confirm it reads from Secrets Manager.

### Token rotation

The Grafana service account token is auto-rotated by a Lambda on an EventBridge
schedule (default: every 25 days). AMG tokens have a max TTL of 30 days, so the
Lambda creates tokens with a TTL of rotation interval + 5-day buffer.

The rotation flow:

1. Lambda reads the current token ID from Secrets Manager.
2. Creates a new token via the `CreateWorkspaceServiceAccountToken` API.
3. Stores the new token in Secrets Manager.
4. Deletes the old token.

A CloudWatch alarm fires if the rotation Lambda errors. If the token expires
before the next rotation (e.g., Lambda was disabled), manually invoke the Lambda
or create a new token with the bootstrap steps above.

### Useful tips

- If AMG workspace creation conflicts, bump `grafana_suffix_seed` in `terraform.tfvars` to force a new workspace name suffix.
- If you change the workspace name, you may want to update `grafana_url` before the second apply.
- To force an immediate rotation: `aws lambda invoke --function-name <project_name>-<environment>-grafana-token-rotation --region us-east-1 /dev/stdout`

## Critical alerts (SNS)

Set `alert_email` in `terraform.tfvars` to enable critical CloudWatch alarm
notifications via SNS. Leave it empty to disable all alerting resources.

After the first `terraform apply`, you must **confirm the subscription** by
clicking the link in the confirmation email AWS sends to that address.

### What triggers an alert

| Alarm                         | Condition                                     | Period    |
| ----------------------------- | --------------------------------------------- | --------- |
| ECS no running tasks          | Bot service running task count < 1 for 10 min | 5 min x 2 |
| ALB target 5xx errors         | 10+ target HTTP 5xx responses in 10 min       | 5 min x 2 |
| ALB unhealthy hosts           | Any unhealthy target for 10 min               | 5 min x 2 |
| Grafana token rotation errors | Rotation Lambda error in 24 h                 | 1 day x 1 |

All alarms also send an OK notification when the condition clears.

The SNS topic is encrypted with the `app_general` KMS key and restricted to
publishing from CloudWatch Alarms and EventBridge within the same account.

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

3. Redeploy the ECS service (or force a new deployment) so tasks pick up the new secrets.

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
