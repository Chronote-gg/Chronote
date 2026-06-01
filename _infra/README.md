# Infrastructure Notes

## Terraform state bootstrap

The standalone `_infra_state_mgmt` stack provisions the remote state bucket and
lock table used by `_infra/main.tf`. The state bucket is private, versioned,
encrypted with a dedicated KMS key, and has S3 public access blocking enabled.

Apply this bootstrap stack before initializing the main infrastructure backend.

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

Set `alert_email` and/or `alert_discord_channel_id` in `terraform.tfvars` to
enable critical CloudWatch alarm notifications via SNS. Leave both empty to
disable all alerting resources.

After the first `terraform apply` with `alert_email` set, you must **confirm
the subscription** by clicking the link in the confirmation email AWS sends to
that address.

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

### Discord channel alerts

When `alert_discord_channel_id` is set, a Node.js 24 Lambda subscribes to the
SNS topic and posts rich embeds to the specified Discord channel. The Lambda
reads the bot token from Secrets Manager (cached across invocations) and calls
the Discord REST API directly (no discord.js dependency), so it works even when
the main application is down.

**Setup:**

1. Create a dedicated `#alerts` text channel in your Discord server.
2. Copy the channel ID (right-click the channel with Developer Mode enabled).
3. Ensure the bot has `SendMessages` and `EmbedLinks` permissions in that channel.
4. Set `alert_discord_channel_id` in `terraform.tfvars` and run `terraform apply`.

**Embed format:**

- Color-coded: red for ALARM, green for OK, grey for unknown states.
- Fields: status transition, region, metric/namespace, threshold, evaluation
  period, reason (truncated to 1024 chars), and a deeplink to the CloudWatch
  console alarm page.
- Footer: "CloudWatch Alarm" with the state change timestamp.

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

## Environments (production, sandbox, staging)

Terraform now supports environment-specific resource naming via `environment`
and `project_name` in `terraform.tfvars`.

Recommended workflow:

1. Use the default Terraform workspace for production only.
2. Use a separate `sandbox` Terraform workspace for sandbox resources.
3. Set `environment="prod"` and `github_environment="production"` for production.
4. Set `environment="sandbox"` and `github_environment="sandbox"` for sandbox.
5. Do not point the `sandbox` GitHub Actions environment at production resources.

Terraform also writes deploy variables back to GitHub. Keep `github_owner` and
`github_repository` pointed at the repository that owns the deployment workflows
(currently `Chronote-gg/Chronote`).

GitHub environments contain environment-scoped secrets. Terraform protects the
managed GitHub environment from destruction so a production plan cannot replace
an existing state entry that still points at the old `sandbox` environment. If a
plan shows `github_repository_environment.repo_env` needs replacement, stop and
migrate/import the GitHub environment state before applying.

If you prefer separate variable files, use:

- Prod: `terraform -chdir=_infra plan -var-file=terraform.tfvars`
- Sandbox: copy `terraform.sandbox.tfvars.example` to `terraform.sandbox.tfvars`, then run
  `terraform -chdir=_infra plan -var-file=terraform.sandbox.tfvars`
- Staging: copy `terraform.staging.tfvars.example` to `terraform.staging.tfvars`, then run
  `terraform -chdir=_infra plan -var-file=terraform.staging.tfvars`

## Terraform plan and apply workflows

`.github/workflows/terraform-plan.yml` is a manual plan workflow. It does not run
on merge. Use it before planned infra work or when checking drift after deploys.
When the plan has changes, it uploads a short-lived `tfplan` artifact and writes
the artifact name, plan run ID, and SHA-256 to the workflow summary.

`.github/workflows/terraform-apply.yml` is a manual apply workflow. It downloads a
reviewed plan artifact from a specific plan run, verifies the SHA-256, and applies
that saved plan. It does not generate a fresh unreviewed plan during apply.

Each GitHub environment used by the workflow must provide:

- Secret `AWS_ACCESS_KEY_ID`
- Secret `AWS_SECRET_ACCESS_KEY`
- Secret `TERRAFORM_TFVARS_JSON`

The workflow dispatch choices should only list GitHub Actions environments that
already exist and have these secrets configured. Production plans must use the
`production` GitHub environment with the `default` Terraform workspace. Sandbox
plans must use the `sandbox` GitHub environment with the `sandbox` Terraform
workspace.

`TERRAFORM_TFVARS_JSON` is the environment-specific Terraform variable file as
JSON. Keep it aligned with the private `terraform.tfvars` values used for manual
plans. The workflow validates that required variables are present and rejects a
non-empty `grafana_api_key` after Grafana token rotation is active. Use
`grafana_service_account_id` and the rotated Secrets Manager token instead.

Recommended apply flow:

1. Run **Terraform Plan** for the target GitHub environment and Terraform
   workspace.
2. Review the plan log and workflow summary.
3. If the plan is acceptable, run **Terraform Apply** with the plan run ID,
   artifact name, and SHA-256 from the plan summary.
4. Type `apply` in the confirmation input.
5. Approve the GitHub environment gate for production-like environments.

Plan artifacts contain a binary Terraform plan and can include sensitive values.
They are retained for one day. Do not download or share them outside the
maintainer workflow.

Merges do not reconcile Terraform drift. The deploy workflows update ECS task
definitions, S3 objects, and CloudFront invalidations directly, while Terraform
owns the baseline infrastructure. Review plan output before applying, especially
ECS task definition replacement and provider normalization diffs.

## Emergency drift repair

Prefer the plan/apply workflows for all routine infrastructure changes. If a
production incident requires a direct AWS repair, make the smallest possible
change, record exactly what changed in an issue, and reconcile Terraform state as
soon as the incident is stable.

For directly-created resources already declared in Terraform, import them into
state before the next apply. Example:

```bash
terraform -chdir=_infra init -input=false
terraform -chdir=_infra import aws_dynamodb_table.meeting_control_command_table meeting-notes-prod-MeetingControlCommandTable
```

After importing, run the Terraform Plan workflow with the real environment
tfvars and verify the repaired resource is no longer shown as drift.
