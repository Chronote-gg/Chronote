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

- If AMG workspace creation conflicts, bump `grafana_suffix_seed` in `terraform.tfvars` to force a new non-production workspace name suffix. Production is pinned to the existing workspace seed in Terraform code; do not change it without an approved replacement plan.
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
- Do not copy production secrets into sandbox. Provision sandbox credentials case by case:
  - `discord-bot-token` and `discord-client-secret`: use a separate sandbox Discord application and bot.
  - `oauth-secret`: generate a sandbox-only random signing secret.
  - `openai-api-key`: prefer a separate OpenAI project/service account with sandbox budget limits.
  - `langfuse-public-key` and `langfuse-secret-key`: prefer a sandbox Langfuse project or environment. If sharing one project intentionally, keep `LANGFUSE_TRACING_ENVIRONMENT=sandbox`.
  - `stripe-secret-key` and `stripe-webhook-secret`: use Stripe sandbox/test-mode credentials and a sandbox webhook endpoint.
  - `notion-client-secret`: use a sandbox Notion public connection, or keep `NOTION_CLIENT_ID` blank and set a dummy value because ECS currently references this secret unconditionally.

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

## Analytics proxy (PostHog)

The portal sends analytics to a first-party subdomain rather than to PostHog's
ingestion host, because ad blockers filter the latter and every metric comes out
skewed low. PostHog runs the proxy itself, so the only infrastructure here is one
CNAME in `_infra/analytics.tf`. There is no CloudFront behavior and no origin.

Three variables control it, all blank by default:

| Variable                       | Purpose                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_KEY`                  | Public ingestion token for server-side capture. Blank disables capture entirely. Not a credential, so `TFVAR_POSTHOG_KEY` is fine. |
| `ANALYTICS_PROXY_DOMAIN`       | The subdomain to serve ingestion from, e.g. `e.chronote.gg`.                                                                       |
| `ANALYTICS_PROXY_CNAME_TARGET` | The CNAME target PostHog issues when the domain is registered.                                                                     |

Leave the proxy pair blank in any non-production workspace. Both must be set
before the record is created, so a workspace with only one of them configured
simply gets no record rather than a broken one.

**Rollout order matters, and getting it wrong is not self-healing.** Setting the
frontend host before the proxy certificate is valid stops the portal sending
analytics until another frontend deploy goes out.

1. Register the domain in PostHog's organization proxy settings. It returns a
   CNAME target and sits in `waiting`.
2. Set `ANALYTICS_PROXY_DOMAIN` and `ANALYTICS_PROXY_CNAME_TARGET`, then apply.
   Remember that a Terraform apply alone does not move a running ECS service:
   a backend deploy has to follow, as described under the plan and apply
   workflows below.
3. Wait for the PostHog record to report `valid`. It verifies automatically once
   DNS resolves and then issues the certificate.
4. Only then set the `VITE_POSTHOG_HOST` Actions variable to
   `https://<ANALYTICS_PROXY_DOMAIN>`. The next frontend deploy picks it up.

To roll back, clear `VITE_POSTHOG_HOST` and deploy the frontend. The portal
returns to sending directly to PostHog, losing the ad-blocker coverage but
nothing else.

## Environments (production, sandbox, staging)

Terraform now supports environment-specific resource naming via `environment`
and `project_name` in `terraform.tfvars`.
Shared-account singleton names should include the environment prefix. This
includes VPC flow log IAM roles and CloudWatch log groups, which otherwise
collide when provisioning sandbox alongside production.
Production keeps its original VPC flow log IAM role and CloudWatch log group
names (`vpc_flow_logs_role` and `/vpc/flow/app-vpc`) to avoid replacing live
logging resources. Non-production environments use environment-scoped names.

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
- Optional secret `REDIS_AUTH_TOKEN`
- Optional secret `REDIS_URL`

The workflow dispatch choices should only list GitHub Actions environments that
already exist and have these secrets configured. Production plans must use the
`production` GitHub environment with the `default` Terraform workspace. Sandbox
plans must use the `sandbox` GitHub environment with the `sandbox` Terraform
workspace.

`TERRAFORM_TFVARS_JSON` is the environment-specific Terraform variable file as
JSON. Keep it aligned with the private `terraform.tfvars` values used for manual
plans. The workflow validates that required variables are present and rejects a
non-empty `grafana_api_key` after Grafana token rotation is active. Scalar
values must be JSON strings; the workflow normalizes string arrays only when
they contain exactly one non-empty value, to tolerate existing malformed
environment secrets. During GitHub Actions runs, `AWS_TOKEN_KEY` is overwritten
from the environment's `AWS_ACCESS_KEY_ID` secret before Terraform runs. Use
`grafana_service_account_id` and the rotated Secrets Manager token instead.
When `REDIS_AUTH_TOKEN` or `REDIS_URL` is set as a GitHub environment secret, the
plan/apply workflows overlay it onto `TERRAFORM_TFVARS_JSON` before Terraform
runs. Use this for Redis credential preservation or rotation instead of editing
the large tfvars JSON blob. Both carry credentials, so both are refused through
the `TFVAR_` variable path.

## Cache backend

`ENABLE_ELASTICACHE` decides whether an in-VPC ElastiCache cluster is
provisioned, and `REDIS_URL` always wins over it when set. That gives three
configurations:

- `ENABLE_ELASTICACHE=true`, `REDIS_URL` empty: in-VPC cluster, its endpoint is
  passed to the app. Roughly $12/month per environment.
- `ENABLE_ELASTICACHE=false`, `REDIS_URL` set: external provider (Upstash). No
  cluster, no cost. The URL carries the password, so it belongs in the secret.
  **It must start with `rediss://`, not `redis://`.** Upstash shows the string as
  `redis-cli --tls -u redis://...`, where TLS comes from the flag rather than the
  scheme; ioredis reads only the scheme, so pasting that verbatim connects in
  plaintext to a TLS-only port and retries a reset socket forever. The app now
  refuses such a URL and falls back to its memory cache instead of looping.
- `ENABLE_ELASTICACHE=false`, `REDIS_URL` empty: no Redis at all. The app falls
  back to an in-process memory cache (`src/services/cacheService.ts`), which is
  correct for a single-task environment like sandbox but loses the cache on every
  task replacement.

An external provider reaches the task over the public internet on 6379/TLS. The
ECS service security group currently allows all egress for voice debugging; when
that is tightened back to 443 and DNS, add a rule for the Redis port or the cache
silently falls back to erroring on every call.

### Moving a running environment off ElastiCache

**Do this as two applies with a deploy in between, never as one.** Terraform
writes `REDIS_URL` into a newly registered task definition, but
`aws_ecs_service.app_service` sets `ignore_changes = [task_definition]`, so the
running tasks keep the old value until a backend deploy repoints the service.
Setting `REDIS_URL` and `ENABLE_ELASTICACHE=false` in a single apply therefore
deletes the cluster out from under tasks that are still connected to it, and they
log cache failures until the next unrelated deploy happens to pick up the change.

1. Set `REDIS_URL` to the external provider. Apply. The cluster is still there.
2. Run a backend deploy so the service picks up the new task definition.
3. Confirm the cache is actually working against the new provider.
4. Set `ENABLE_ELASTICACHE=false`. Apply. Now the cluster goes away.

The same ordering applies in reverse, and it is the general rule from the root
`AGENTS.md`: changing a Terraform-managed ECS environment variable takes three
steps, and the deploy is the one people miss.

## Recording-safe backend replacement

Production and Sandbox use `scripts/deployment/coordinator.cjs` after installing
runner dependencies and building the backend protocol builders. Both workflows
serialize deployments per environment and leave running deployments uncancelled.
The coordinator requires the reviewed ECS rolling service with desired count one;
it does not change that count or create another service.

The CLI takes `prepare`, `promote`, `retire`, or `reconcile`. Its environment
inputs are `ECS_CLUSTER`, `ECS_SERVICE`, `ECS_TASK_FAMILY`, `SECRETS_PREFIX`,
`DEPLOYMENT_RUN_TOKEN`, `DEPLOYMENT_CANDIDATE_ID`, and `CANDIDATE_IMAGE` pinned
to an image digest. It derives `DDB_TABLE_PREFIX` as `SECRETS_PREFIX` plus `-`,
checks any explicit override, and verifies the task definition's table route.
It does not retrieve secret values. AWS CLI calls use argument arrays and the
compiled shared DynamoDB transaction builders.

1. **Prepare:** verify the exact compatible serving task, its fresh application
   readiness, and native protection before requesting replacement. Persist the
   coordinator token, epoch, original membership, task/image identity, and phase
   under compare-and-set conditions in the existing control row. Register a
   digest-pinned task definition while preserving unrelated fields.
2. **Promote:** let the old runtime keep serving while the candidate warms.
   Require a fresh proof for the intended `all`, `bot`, or `api` mode, dependencies,
   current epoch/generation, exact task/image identity, and native protection.
   Atomically select the candidate under a new serving generation. An ECS health
   result alone cannot select a runtime or authorize recording work.
3. **Retire:** write an identity, original generation, token, and epoch-bound
   request to the outgoing runtime row. Its heartbeat enters the single local
   retirement barrier. Only that runtime can disable native protection after all
   owned work and voice operations settle. The coordinator requires its exact
   durable retired acknowledgment and subsequent ECS convergence to complete.
   A 7,500-second reporting timeout preserves unfinished work.
4. **Reconcile:** read back ambiguous writes and preserve the old membership on
   pre-promotion failure. Before any retirement request, a still-ready compatible
   prior owner can be selected with another new generation. A candidate that has
   started work remains protected. After retirement starts, or without a safe
   rollback target, report recovery required; never stop busy tasks, delete
   leases, or disable protection to create capacity. Unfinished phases prevent
   another rollout from accumulating protected revisions.

Minimum health remains 100%, maximum 200%, and the application container's stop
timeout is 120 seconds. The coordinator also requests
`earlySuccessCriteria = { enable: true, healthyPercent: 100,
sourceServiceRevisionCleanup: "DEFERRED" }`, preserving unrelated deployment
configuration. AWS documents `DEPLOYMENT_BLOCKED` when protected tasks prevent a
deployment reaching steady state, and recommends deferred source cleanup for
protected tasks. These settings remove that documented cleanup dependency;
simultaneous old/candidate protection and renewal acceptance remain **UNKNOWN**
until an authorized native test proves them. Actual protection acknowledgments
remain mandatory. See [AWS early-success criteria](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/early-success-criteria.html)
and [API failure messages](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/api_failures_messages.html).

The runner validates its UpdateService CLI input model with an output skeleton
before any coordinator mutation. AWS provider 6.64.0 has no matching Terraform
field, so this setting is owned by the shared coordinator. Unsupported runner
models fail before replacement; a supported local model is not proof of service
acceptance. The native update and its configuration are checked before promotion.

ECS startup opens one health-only listener on the existing port before initial
protection. `/health` reports liveness; `/ready` stays unready and other requests
receive retryable 503 responses until protection permits full application boot.
Only exact-task initial `DEPLOYMENT_BLOCKED` receives bounded retries within the
15-minute warmup allowance, with cancellation and finite request timeouts. Full
API routes reuse that listener. Source protection keeps its existing minute
renewal and two-minute safety margin; a positive disabled/unsafe proof invalidates
an older cached confirmation immediately.

Early ECS success ends provider automatic rollback monitoring sooner. The
coordinator therefore continues checking application readiness, owns the later
rollback decision, and waits for runtime retirement. Early `SUCCESSFUL`, a quiet
lease table, and a task-count snapshot are not recording-safe completion proof.

The completed protocol branch is the first compatible ECS release. Intermediate
implementation revisions have incompatible strict record schemas and cannot be
treated as deployed warm-replacement targets. First activation requires its own
reviewed compatible task/image and control-row evidence. The coordinator refuses
missing or incompatible control state instead of silently enrolling legacy
tasks. Qualifying readiness also requires the complete runtime safety handler;
an incomplete composition must remain unready. No deployment is implied by the
local fixture tests or these infrastructure definitions.

The new deployment-control table retains top-level `hash_key` and `range_key`:
the pinned provider requires them and rejects a top-level `key_schema` block.
Existing GSI key deprecation warnings belong to the provider's nested-index
migration and are not addressed by changing unrelated live tables here.

## Parking a non-production environment

Nearly all of an idle environment's cost is the API ALB and the cache cluster.
The DynamoDB tables are on-demand, and S3, CloudFront, ACM and ECR are free while
unused, so there is no reason to destroy the whole workspace to stop paying for
it. Three variables park it instead:

- `ENABLE_API_ALB=false` removes the load balancer, its listeners, target group
  and alias record. A bot-only environment does not need inbound traffic at all,
  because the Discord gateway connection is outbound. You do lose the portal,
  OAuth callbacks and Stripe webhooks until it is flipped back.
  The ALB **security group is deliberately kept**, along with the ECS service's
  ingress rule referencing it. Security groups are free, and the alternative does
  not work: the AWS provider treats an absent inline rule attribute as unmanaged
  rather than empty, so a rule that stops being emitted is left in place and then
  blocks the group's own deletion with a `DependencyViolation`. Expect an
  unattached security group in a parked environment; it is not leftover cruft.
- `ECS_DESIRED_COUNT=0` stops the task without touching the service definition.
  This bypasses the backend coordinator's runtime retirement acknowledgment.
  A quiet lease scan is not proof that owned work or voice operations have settled.
  Parking requires a separately reviewed shutdown with actual runtime retirement
  evidence; do not use a count change to force unfinished work to stop.
  A variable validation refuses this outright when `environment` is `prod`.
- `ENABLE_ELASTICACHE=false` drops the cache cluster.

**`ENABLE_API_ALB_DELETION_PROTECTION` has to be false before `ENABLE_API_ALB`
can go false.** Terraform cannot destroy a protected load balancer, and it does
not clear the flag first, so flipping both at once fails the apply. Non-production
environments should just leave protection off permanently.

`ENABLE_API_ALB=false` requires `API_DOMAIN` to be set, enforced by a variable
validation: `api_base_url` falls back to the ALB's DNS name, and with no ALB and
no domain there is nothing left for it to resolve to.

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

## Renewal and lifecycle rollout

STRIPE_RENEWAL_REACTIVATION_ENABLED and BILLING_LIFECYCLE_ANALYTICS_ENABLED both default to false and are independent of STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED. Keep them in environment-scoped TFVAR_ variables, apply a reviewed plan, then deploy the backend to use its task definition. A merge alone does not activate them.

Turning the renewal-action flag off stops new provider writes, including retries. Existing operations can still be checked and reconciled. Do not delete their control records or create replacement Checkout to escape uncertainty. Resolve source or price drift through support; do not recancel a successfully restored subscription.

Publish the updated Privacy Policy and What's New notice before lifecycle capture is enabled. Baseline reconciliation and private invoice receipts run independently of capture. A first observation is not a historical cancellation. Invoice deduplication markers are eligible for deletion after 400 days; event capture is best effort, not a financial audit trail. Verify actual Sandbox event rows before production rollout, and keep saved insight configuration separate from code verification.

### Renewal payment grace

`STRIPE_RENEWAL_GRACE_ENABLED` defaults to `false`. It is independent of
reactivation, plan switching and lifecycle analytics. Prepare the recovery index
and prove complete paid-period coverage before enabling it. Keep provider
credentials, account IDs, deployment identifiers and full audit reports in the
private operations workspace described in the repository's `AGENTS.md`.

1. Keep the environment-scoped GitHub variable
   `TFVAR_STRIPE_RENEWAL_GRACE_ENABLED=false`. Review and apply a saved Terraform
   plan that adds `RenewalRecoveryDueIndex`, its query permission and the
   subscription table's `dynamodb:DescribeTable` permission. Wait for the index to
   become `ACTIVE`.
2. Deploy the intended backend image with grace disabled. Terraform apply creates
   a task definition, but the service ignores task-definition drift. A subsequent
   backend deployment must move the service to that definition. Verify the exact
   AWS environment, provider account and mode, running image digest, and flag.
3. Obtain a normal-writer record from that deployed API image through an
   authorized paid-subscription reconciliation. It must carry
   `writerVersion=renewal-grace-v1` and the actual ECS task ARN and image digest.
   An imported record or a simulated witness cannot establish deployment
   readiness. If there is no eligible paid subscription, arrange an authorized
   fixture before continuing.
4. Run the bounded audit below. It is read-only by default. Set each variable
   from the reviewed environment's private owner note. The example uses Sandbox
   provider mode; a production run needs its own scope and authorization.

   ```bash
   yarn ts-node scripts/billing-renewal-recovery.ts \
     --account "$STRIPE_ACCOUNT_ID" --mode test \
     --report "$PRIVATE_REPORT_PATH" --max-pages 20 \
     --cluster "$ECS_CLUSTER_ARN" --service "$ECS_SERVICE_ARN" \
     --container "$ECS_CONTAINER_NAME" --image "$API_IMAGE_DIGEST"
   ```

5. With enforcement still disabled, repeat the command with `--apply` to write
   owned DynamoDB coverage records. It does not edit Stripe or enable grace.
   Require a successful exit and a private report with `coverageReady=true`,
   `enumeration=complete`, `indexActive=true`, `writerVerified=true`, and only
   `covered` or `ignored` outcomes. Readiness includes two complete traversals and
   an exact current deployed-writer check. Unpaid trials without paid history are
   ignored; first-payment failures receive no renewal grace. Applied runs exit
   nonzero if any prerequisite is missing, including an inactive index or
   unverified writer.
6. If the page bound or a failure leaves the report incomplete, resume with
   `--resume` and the same account, mode, report and apply scope. Preserve its
   cursor and phase. A completed but unready audit needs correction and a fresh
   report, rather than resuming its completed cursor. Keep enforcement off while
   resolving provider errors, source drift or a retired writer witness.
7. After accepting coverage and the environment's rollout gate, set
   `TFVAR_STRIPE_RENEWAL_GRACE_ENABLED=true`, review and apply the resulting saved
   plan, then deploy the backend. Verify the running task's environment and image
   before exercising an authorized renewal failure. Check the saved deadline,
   original-payer retry/cancel flow, preserved unrelated charges and hosted expiry.
   Native test clocks or local DynamoDB do not replace signed-in hosted
   acceptance. Sandbox's first activation also follows
   [the controlled bootstrap procedure](../docs/sandbox-bootstrap.md).

To stop new grace adoption, set the variable back to `false`, apply and deploy.
Already accepted recoveries continue through their original deadline and durable
cleanup. Turning the flag off does not remove financial fences or restore expired
access. Preserve their records and reconcile them through the recovery path.

## Sandbox backend deployment identity

Sandbox backend deployments use the Terraform-managed GitHub OIDC role. Its trust requires
this repository's immutable IDs, the `sandbox` environment and a `master` or `codex/*`
branch. Terraform creates `SANDBOX_BACKEND_DEPLOY_ROLE_ARN` and `AWS_ACCOUNT_ID`
environment variables and attaches the existing deployment-routing policy. The shared
OIDC provider is read as data and remains owned by its existing configuration.

Use the manual `Sandbox Deployment Identity` workflow for the first identity check.
Its session permits only the Sandbox service metadata read. Both the canary and backend
verify the exact account, role and run session before proceeding. The backend uses a
three-hour session to cover bounded warmup and retirement; it has no static-key fallback.

The Sandbox task-role AppConfig policy is scoped to its application, profile,
environment, configuration and deployment strategy. Production retains its existing
policy in this change. Frontend, docs and Terraform authentication are separate.

Run the mocked policy checks with `terraform -chdir=_infra init -backend=false` and
`terraform -chdir=_infra test`. Live introduction still requires a reviewed full saved
plan, the existing Apply gate, the identity canary and the guarded bootstrap described
in [sandbox-bootstrap.md](../docs/sandbox-bootstrap.md).

### First Sandbox activation

The manual Sandbox Deployment Identity workflow still defaults to a read-only
identity check. Optional bootstrap phases are explicit:

- `prepare` publishes a source-pinned image and registers a candidate definition
  using the scoped Sandbox role. It does not replace the running service.
- `activate` requires the reviewed manifest in the Sandbox environment secret
  `SANDBOX_BOOTSTRAP_MANIFEST`, its checksum, and the same operation UUID. The
  manifest source must match the workflow source. Its exact STS session is
  `chronote-sandbox-<decimal value of the UUID without hyphens>-1`.
  The job refuses reruns and verifies the actual identity before writes.
- `repair` requires a new prepared candidate UUID and the reviewed old/new manifest
  envelope in `SANDBOX_BOOTSTRAP_MANIFEST`. Supply the checksum of the entire
  parsed envelope. It accepts only the exact acknowledged, unserved first
  activation after its coordinator lease expires. See the linked bootstrap
  runbook for settlement, conditional supersession, and no-replay requirements.
- `probe_without_environment` runs a separate read-only trust probe with no
  GitHub environment. Its job should fail at assumption. Verify AWS AccessDenied
  after OIDC token retrieval; configuration failures or timeouts are not trust
  evidence. A dispatch from a tag can separately verify the disallowed-ref case.

Preparation, activation, and repair are serialized with normal Sandbox deployments. A
durable INTRODUCTION receipt fences the one-time stop and listener writes.
Initialization accepts only its exact acknowledged operation, principal and
manifest checksum. Unknown provider acknowledgments stop the operation; do not
rerun it or clear the receipt. Candidate readiness, native protection and a fresh
serving heartbeat remain required.

This first-activation route conservatively requires empty lease, command and
personal-job tables and terminal complete/cancelled history status. These checks
do not establish maintenance input isolation. Record that proof separately in
the private activation packet before creating the executable manifest. Never
derive it from a quiet scan. Keep manifest contents and provider receipts out of
public logs and artifacts. Normal compatible deployments use the coordinator.
