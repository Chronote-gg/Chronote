# Infrastructure Notes

## Bot worker capacity

The task definition selects CPU, memory and ephemeral storage from `environment`:

| Environment                           | CPU      | Memory | Ephemeral storage    |
| ------------------------------------- | -------- | ------ | -------------------- |
| `prod`                                | 1 vCPU   | 2 GiB  | 60 GiB               |
| Other environments, including Sandbox | 0.5 vCPU | 1 GiB  | 20 GiB (the default) |

Per-speaker PCM takes about 0.69 GB per speaker-hour and the image and runtime
about 8.7 GB at startup, so one two-hour meeting with nine speakers could fill the
default. A deploy-registered revision copies the whole task definition, so the
size survives deploys.

Task reservations and container limits use the same values. Recording buffer
limits remain independent of the task size.

A Terraform apply registers the new task definition. The service ignores task
definition changes from Terraform, so a backend deploy is also required to move
the running worker to the new size. See
[changing a Terraform-managed environment variable](../docs/deployment.md#changing-a-terraform-managed-environment-variable),
which follows the same three steps.

## Terraform state bootstrap

The standalone `_infra_state_mgmt` stack provisions the remote state bucket and
lock table used by `_infra/main.tf`. The state bucket is private, versioned,
encrypted with SSE-S3 and has S3 public access blocking enabled. The stack's
source also declares a dedicated KMS key for it, but its committed local state is
stale and production uses SSE-S3 (checked 2026-11-17), so treat that source as
unapplied.

Apply this bootstrap stack before initializing the main infrastructure backend.

## Container image retention

The ECR lifecycle policy keeps the last two untagged images and retains tagged
release images until a separately reviewed retirement. Tagged releases accumulate,
so storage use can grow. Merging this source change does not update ECR. The policy
takes effect only after a separate reviewed Terraform apply.

## Transcript bucket retention

The transcript bucket's lifecycle rule aborts incomplete multipart uploads seven
days after they start. Nothing deletes completed objects: there is no retention
period or expiry rule for meeting artifacts, including recording checkpoints.

## Observability

CloudWatch and SNS provide operational alarms. Chronote uses PostHog for
product analytics. The application still exposes `/metrics` for local Prometheus.

For each environment, review the saved plan for deletion of its managed Grafana
and Prometheus workspaces and the Grafana-only supporting resources. Keep the
Grafana provider address and state removal blocks until every workspace has
applied the retirement. Once the managed workspaces are gone, remove the
retired service grants from both Terraform bootstrap roles in a separate Apply.

## Critical alerts (SNS)

Set `alert_email` and/or `alert_discord_channel_id` in `terraform.tfvars` to
enable critical CloudWatch alarm notifications via SNS. Leave both empty to
disable all alerting resources.

After the first `terraform apply` with `alert_email` set, you must **confirm
the subscription** by clicking the link in the confirmation email AWS sends to
that address.

The topic is encrypted with the application key, so every publisher needs that
key's policy. **Until the 2026-11-27 key policy fix is applied, alarm
notifications fail.** Every alarm action in the retained 30 day history (from
2026-10-28) failed, the topic published nothing in the 90 days checked, and the
faulty condition dates from the topic's creation in February 2026, so probably
none was ever delivered. The `AllowSNSPublishers` statement required
`kms:CallerAccount`, which does not match the CloudWatch service principal, and
every alarm action failed with "CloudWatch Alarms does not have authorization to
access the SNS topic encryption key". It is now scoped by the SNS encryption
context `kms:EncryptionContext:aws:sns:topicArn` instead. Subscribers need no key
access: SNS decrypts before delivery. `tests/alert-delivery.tftest.hcl` pins the
grant and that every alarm notifies the topic. The proof step after the Apply and
the daily delivery check are in
[the deployment document](../docs/deployment.md#alarm-delivery).

### What triggers an alert

| Alarm                       | Condition                                      | Period    |
| --------------------------- | ---------------------------------------------- | --------- |
| ECS no running tasks        | Bot service running task count < 1 for 10 min  | 5 min x 2 |
| ECS disk leak               | Bot task disk minimum above 75% for 3 h        | 1 h x 3   |
| ECS disk critical           | Bot task disk at or above 95% of reserved      | 5 min x 1 |
| ALB target 5xx errors       | 10+ target HTTP 5xx responses in 10 min        | 5 min x 2 |
| ALB ELB 5xx errors          | 5+ load-balancer HTTP 5xx responses in 5 min   | 5 min x 1 |
| ALB ELB 5xx sustained       | 5+ load-balancer HTTP 5xx responses in 1 h     | 1 h x 1   |
| ALB unhealthy hosts         | Any unhealthy target in `api-tg` for 10 min    | 5 min x 2 |
| ALB spare unhealthy hosts   | Any unhealthy target in `api-spare` for 10 min | 5 min x 2 |
| Checkout lock stuck         | `Checkout lock stuck` app log line in 1 h      | 1 h x 1   |
| OpenAI requests rejected    | Any OpenAI quota, credit, or 429 log line      | 5 min x 1 |
| Processing retry worker     | `Processing retry worker failed` log line      | 5 min x 1 |
| Voice settlement unresolved | Unreleased voice session or lease log line     | 5 min x 1 |
| Voice admission blocked     | Recording refused for uncertain voice state    | 5 min x 1 |
| Meeting lifecycle stuck     | `MeetingStuck` metric, any phase               | 5 min x 1 |
| Meeting finish failed       | `MeetingFailed` metric, finish or delivery     | 5 min x 1 |
| Task protection failing     | 3+ `TaskProtectionFailed` in 5 min             | 5 min x 1 |
| No eligible worker          | No `WorkerEligibleHeartbeat` in 5 min          | 5 min x 1 |
| Finisher scan missing       | No `FinisherScanCompleted` in 10 min           | 5 min x 2 |
| Renewal recovery stalled    | `RenewalRecoveryStalled` in each of 3 periods  | 5 min x 3 |
| Deploy drain timeout        | Deploy `DrainWaitTimedOut` metric published    | 5 min x 1 |

All alarms also send an OK notification when the condition clears.

The two unhealthy-host alarms cover both target groups of the pair, one alarm
each. Deployments do not move traffic between them: `deploy.cjs preflight`
refuses unless the listener sends full weight to the group the service is bound
to. The spare group and its alarm stay until the unused deployment
infrastructure is removed. An idle group publishes no `UnHealthyHostCount`
datapoints, so with `notBreaching` its alarm sits OK.

`HTTPCode_ELB_5XX_Count` is separate from the target 5xx alarm on purpose. The
load balancer answers 502, 503 or 504 itself when it has no healthy target to
forward to, and target 5xx stays at zero for the whole window, so this is the
only alarm that sees a swap landing on an empty target group. It is also
deliberately more sensitive than the target 5xx alarm, at 5 in a single period
rather than 10 across two, because an ELB 5xx means there was nothing healthy to
forward to and is rarely benign, whereas target 5xx is an application error rate
that needs a higher bar; do not harmonise the two.

**There are two alarms on `HTTPCode_ELB_5XX_Count` on purpose, and neither is
redundant.** They share a metric and a dimension and differ only in time base.
The 5-minute alarm catches a concentrated burst within five minutes but misses a
trickle, because a trickle never reaches 5 in any single period. The 1-hour
alarm catches that trickle, at the cost of up to an hour of latency. No single
time base covers both shapes, so deleting either one reopens the gap they exist
to close. The sizing comes from the 2026-11-02 outage, which produced 4, 14 and
2 ELB 5xx across three consecutive hourly buckets with target 5xx at zero
throughout: the 14 crosses the hourly threshold, so that incident would have
paged. A burst big enough to trip the fast alarm will usually trip the slow one
too, so expect one real outage to notify twice.

The lifecycle alarms in `alerts-lifecycle.tf` read metrics in
`<name_prefix>/Lifecycle` that the workers publish as Embedded Metric Format
lines (`src/lifecycleMetrics.ts`); no alarm depends on log wording. What each one
means and what to do is in [the deployment document](../docs/deployment.md#alarms).
`test/scripts/lifecycleAlarms.test.ts` fails if an alarm's metric is not emitted
by the code or an emitted metric has no alarm. The task gets the namespace as
`METRICS_NAMESPACE`, so a running task publishes nothing until a deploy after
the Apply that adds it. **No eligible worker alarms on
silence** (missing data is breaching), so it fires wherever alerting is enabled
and no worker is eligible, including the window before the first deployment of
the worker registry finishes its cutover. **Finisher scan missing alarms on
silence the same way**: it fires when no eligible worker completed a finisher
scan for ten minutes, so it also fires whenever no worker is eligible. A parked
environment (`ECS_DESIRED_COUNT = 0`) gets neither alarm. The drain alarm
watches the dimensionless `<name_prefix>/Deploy` `DrainWaitTimedOut` metric that
`scripts/deployment/deploy.cjs wait-drain` publishes when it gives up.

The two voice alarms match single app log lines, each a thrown error message:
`Meeting voice or lease release remains unresolved` for a meeting that finished
without releasing its voice session or lease, and
`Voice session admission blocked: voice_uncertain` for a recording refused
because a previous runtime's voice state is still uncertain. Neither moves an
ECS, ALB or OpenAI metric, so without these filters the only symptom is one
meeting that never finishes or never starts. Both fire on a single occurrence,
because one is already worth looking at. The worker design keeps no durable
voice record, so these lines belong to the old runtime; both alarms stay in
place with the rest of the unused deployment infrastructure until it is removed.

**The two ephemeral storage alarms exist because a task with a full disk is
still running.** It passes its health check and keeps answering the load
balancer, so running task count, target health and both 5xx metrics stay clean
while recording, transcription and notes fail on write. That is the shape of the
incident that motivated them: the serving task reached 21 GB used and 0 free
with every alarm in the account reading OK.

**The leak alarm uses `Minimum`, not `Average` or `Maximum`, and that is the
whole point.** Healthy operation peaks to 19.4 and 19.5 GB in a busy hour and
falls back to a 13.3 GB floor, so a static threshold on Average or Maximum fires
on a healthy busy hour and gets muted as noise. Only a leak raises the floor: the
measured leak took the hourly minimum from 13.3 to 18.1 overnight and then to the
21.5 ceiling, and 13.3 against 18.1 separates cleanly. **The pair is deliberate
and neither half is redundant.** They share a metric and dimensions and differ in
statistic and time base, so the hourly `Minimum` catches a slow leak over three
hours and the five-minute `Maximum` catches an imminent ceiling at once. Deleting
either reopens half the gap.

**Both thresholds are computed from the reserved size** (`local.bot_task_storage_gib`
in `main.tf`), in the decimal GB that `EphemeralStorageUtilized` reports: the leak
alarm at 75 percent rounded down, the critical alarm at 95 percent to one decimal.
That is 48 and 61.2 of 64.42 GB in production (60 GiB) and 16 and 20.4 of 21.47 GB
in Sandbox (the 20 GiB default). Changing the size is not a one-step change: it is a Terraform change
plus a backend deploy, because `aws_ecs_service` carries
`ignore_changes = [task_definition]`, so an apply registers a new task definition
revision while the service keeps running the old one until a deploy repoints it.

### ALB access logs

**Off by default, behind `ENABLE_ALB_ACCESS_LOGS` (default `false`), and the
privacy notice has to ship before it is flipped.** Access logs retain client IP
addresses, which is a new category of personal data in a new place, and
`apps/docs-site/docs/legal/privacy.md` promises notice on the page and in the
What's New feed before a material change takes effect. With the flag off, no
bucket is created and the load balancer has no `access_logs` block at all, so
merging this does not start collecting anything. Flip it by setting a
`TFVAR_ENABLE_ALB_ACCESS_LOGS` GitHub Actions **variable** to `true`, not by
editing the `TERRAFORM_TFVARS_JSON` secret, per the rule earlier in this file:
the secret is write-only and a flag parked in it cannot be read back or
reviewed. Then apply.

Once enabled, the API load balancer writes access logs to its own bucket,
`<project>-<environment>-alb-logs-<account id>`, under the `alb/` prefix. The
alarms above say that an outage happened; these say which requests it happened
to, which is what attributing a 4xx or a load-balancer 5xx to a route, a method
or a client needs.

Two details are deliberate and easy to break:

- **The bucket is encrypted with SSE-S3, not the `app_general` KMS key the other
  buckets use.** Elastic Load Balancing supports only S3-managed keys for access
  log delivery. A customer managed key does not fail loudly; log delivery simply
  never starts.
- **The bucket policy grants the `logdelivery.elasticloadbalancing.amazonaws.com`
  service principal**, which AWS documents for all regions, rather than the
  legacy regional Elastic Load Balancing account id (`127311923021` for
  `us-east-1`). The legacy form is still accepted in older regions but AWS
  recommends replacing it. The policy is restricted by `aws:SourceArn` to this
  account's load balancers, and the object path carries the account id, which
  AWS requires rather than merely suggesting.

A 30-day lifecycle rule expires the logs: the forensic value of a raw request log
drops off quickly, and the short window also bounds how long client IP addresses
are retained. The bucket is versioned, so the rule expires noncurrent versions
after a day as well; without that, expiring the current version would only write
a delete marker and retain those addresses indefinitely.

`Checkout lock stuck` is logged when a billing page load finds a server's purchase
lock past its checkout expiry but unreleasable: Stripe still reports the session
open an hour later, or the session no longer matches the stored attempt. The log
line carries the guild id; the `checkout_lock_release_total` counter on
`/metrics` breaks every release attempt down by outcome.

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

`.github/workflows/terraform-plan.yml` and `.github/workflows/terraform-apply.yml`
are manual and run on `master` only. Plan makes one full saved plan, stores it in
the state bucket and summarizes its resource changes; Apply applies that exact plan after the
environment reviewer approves it. See [Terraform delivery](../docs/terraform-delivery.md).

Production plans in the `production` GitHub environment and applies in
`production-terraform`, which the owner creates by hand and Terraform never
manages; both use the `default` workspace. Sandbox uses `sandbox` and the
`sandbox` workspace for both. The settings each environment needs are listed in
[Terraform delivery](../docs/terraform-delivery.md#plan-review-apply).

`TERRAFORM_TFVARS_JSON` is the environment-specific Terraform variable file as
JSON. `scripts/deployment/terraform-tfvars.py` renders it, drops retired Grafana inputs, and normalizes string
arrays only when they contain exactly one non-empty value. Any variable
`TFVAR_<KEY>` overrides `<KEY>`; credentials are refused through that path. A leftover `AWS_TOKEN_KEY` in the secret is dropped. When
`REDIS_AUTH_TOKEN` or `REDIS_URL` is set as an environment secret, it overlays the
tfvars, which is how to rotate Redis credentials without editing the large blob.

The KMS key policy has one configured owner, `aws_kms_key_policy.app_general`.
Encrypted CloudWatch log groups and the critical-alert SNS topic wait for its
service grants during cold creation. A plan may add more than one index to the
history table; DynamoDB creates one global secondary index per table update, so
if Apply fails there, add one index first. Turn on
`meetings.processingRetry.enabled` only once `ProcessingRetryDueIndex` is ACTIVE. Lowering the API target groups'
`deregistration_delay` to 5 seconds cuts a draining task's long in-flight
requests, such as MCP live-transcript streams, after 5 seconds. When
`scripts/public-routes.json` gains a route, the frontend route rewrite's
`publicRoutes` list must gain it too, and only an Apply ships that change.

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

## Backend deployment

Production and Sandbox deploy the backend with `scripts/deployment/deploy.cjs`
from `deploy.yml` and `deploy-staging.yml`. The backend job waits for any
older task still recording a meeting (`wait-drain`, up to 160 minutes), checks
the service and listener (`preflight`), registers a new task definition
revision and updates the service (`rollout`), waits for a ready worker on that
revision (`wait-ready`, up to 15 minutes) and rolls back on failure. It never
changes the listener, the load balancer binding or the desired count. Workers
register themselves in the deployment control table under the `WORKERS`
partition, and the newest ready release takes new meetings.

The update keeps minimum health at 100% and maximum at 200%, turns the
deployment circuit breaker off so ECS never moves the service to a lower revision
by itself, sets the 300 second health check grace period, and requests
`earlySuccessCriteria = { enable: true, healthyPercent: 100,
sourceServiceRevisionCleanup: "DEFERRED" }`, which AWS recommends when old
tasks are protected. See
[AWS early-success criteria](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/early-success-criteria.html).

How it works, the alarms, the one-time first deployment from the old protocol
and the operator commands for stranded meetings are in
[the deployment document](../docs/deployment.md).

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
  A meeting still recording ends at its last saved piece, and no worker finishes
  it until the environment runs again; a meeting still open 24 hours after its
  capture began is then marked failed without a post. Park when nothing is
  recording or processing. A parked environment gets no `no_eligible_worker`
  or `finisher_scan_missing` alarm. A variable validation refuses this
  outright when `environment` is `prod`.
- `ENABLE_ELASTICACHE=false` drops the cache cluster.

**`ENABLE_API_ALB_DELETION_PROTECTION` has to be false before `ENABLE_API_ALB`
can go false.** Terraform cannot destroy a protected load balancer, and it does
not clear the flag first, so flipping both at once fails the apply. Non-production
environments should just leave protection off permanently.

`ENABLE_API_ALB=false` requires `API_DOMAIN` to be set, enforced by a variable
validation: `api_base_url` falls back to the ALB's DNS name, and with no ALB and
no domain there is nothing left for it to resolve to.

Apply flow: run **Terraform Plan**, read its summary, then run **Terraform
Apply** with the plan run ID and the bundle SHA-256 from that summary and approve
it ([Terraform delivery](../docs/terraform-delivery.md)). Saved plans contain
every variable value, credentials included; they stay in the state bucket under
`terraform-plans/`.

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

5. Standalone `--apply` is currently disabled: the script refuses before any
   domain or provider write (`STANDALONE_COVERAGE_APPLY_REFUSAL` in
   `src/services/renewalRecoveryCoverage.ts`), and restoring it needs a
   separately reviewed executor. The audit stays read-only and cannot register or
   refresh recovery records. Once apply is restored: with enforcement still
   disabled, repeat the command with `--apply` to write
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
   acceptance.

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

The backend job verifies the exact account, role and run session before proceeding.
It uses a three-hour session and assumes the role again after the drain wait, so the
rollout starts on a fresh session; it has no static-key fallback.

The Sandbox task-role AppConfig policy is scoped to its application, profile,
environment, configuration and deployment strategy. Production retains its existing
policy in this change. Terraform authentication remains separate.

### Sandbox site publishing

The Sandbox frontend and docs jobs use the same OIDC role through
`SANDBOX_BACKEND_DEPLOY_ROLE_ARN` and `AWS_ACCOUNT_ID`. Each job requests a
one-hour session named `chronote-sandbox-<run_id>-<run_attempt>` and verifies the
exact account, role and session before any S3 or CloudFront operation.
`scripts/deployment/sandbox-site-session.cjs` validates the configured account,
Sandbox role, region and selected site's bucket and distribution. It masks those
selectors and the resulting policy before exposing the policy to the credentials
action. Valid custom bucket names are preserved.

The frontend session can list its bucket, publish and delete its objects, abort
multipart uploads and invalidate its distribution. Docs also retain distribution
and invalidation reads. KMS use is restricted to S3 in the configured region and
that site's object encryption context. The session policy intersects with the
role's installed policy, which restricts KMS to the existing application key.
Neither job receives backend, IAM, Secrets Manager or other-site permissions.
Missing docs selectors still skip docs publishing. Preflight requires the account
and role selectors instead of static keys and retains its production-target guards.

Before enabling these jobs, `aws_iam_policy.site_publishing[0]` and its
attachment from `_infra/site-publishing.tf` must be installed by a reviewed
Sandbox Terraform Apply (see [Terraform delivery](../docs/terraform-delivery.md)).
Do not install them with direct IAM writes.

Source merge, installed policy, fresh OIDC authentication and actual publishing
require separate evidence. Source tests establish none of the hosted outcomes.
There is no static-key fallback. Retire obsolete GitHub key bindings and their
Terraform producer only after every static caller has migrated and the replacement
has succeeded; a later Terraform apply must not recreate a retired binding.

Run the mocked policy checks with `terraform -chdir=_infra init -backend=false` and
`terraform -chdir=_infra test`.

## Backend deploy role and service settings

Both deploy roles may publish `cloudwatch:PutMetricData` only to the
`<name_prefix>/Deploy` namespace. `ecs:StopTask` on this cluster's tasks is
granted only when `ENABLE_DEPLOY_RETIRE` is true (GitHub Actions variable
`TFVAR_ENABLE_DEPLOY_RETIRE`); without it, a dispatched deploy with
`retire_older_tasks` fails at its first stop and an operator stops the older
task instead. The service's `health_check_grace_period_seconds` is 300, the same
value `deploy.cjs rollout` sets on every update. It is not in `ignore_changes`,
so after the first rollout the refreshed state already matches and Terraform plans
no change; it needs no separate apply.

## Production backend deployment identity

The production role is the identity the `deploy.yml` jobs assume.
Terraform selects it with `environment = "prod"`; GitHub must use `production`.
Its OIDC trust binds the account's existing provider, immutable repository and owner
IDs, the exact production environment subject, and `refs/heads/master`. Topic
branches and tags cannot assume it. The role output is
`production_backend_deploy_role_arn`; Actions receives
`PRODUCTION_BACKEND_DEPLOY_ROLE_ARN` and `AWS_ACCOUNT_ID`.

No workflow assumes the introduction and acceptance-collector roles described
below. They stay in Terraform until the unused deployment
infrastructure is removed; the prompt-guard role is still assumed by the OpenAI
connection sync.

An environment name is not an approval gate, and no workflow checks the
`production` environment's protection. Its required reviewer, `master`-only
branch policy and bypass setting are set by hand in GitHub. Terraform manages
the environment but ignores those settings, so no plan changes them; check them
in the repository settings whenever access changes.

Service writes bind the existing service; PassRole binds the existing task and
execution roles for ECS tasks. Routing reuses the existing HTTPS listener policy,
two target groups and lifecycle ignores. The role reads the worker registry with
`dynamodb:Query` on DeploymentControlTable and holds nothing the deploy path does
not call: no inline policy writes, no ECS Exec, no producer discovery and no table
scans. Those grants served the deleted lifecycle coordinator and were removed,
because the role also runs from the reviewer-free `production-deploy`.

The introduction role and acceptance collector allow `ecs:DescribeTaskDefinition` through a separate `RegionalDefinitionMetadata` statement with `Resource = "*"` and the configured `aws:RequestedRegion`. The [ECS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html) does not support resource-level authorization for that operation. This permits regional task-definition metadata reads beyond the reviewed families. The source still validates exact reviewed definition ARNs, account, region and family; IAM does not enforce that narrower selection. The collector inherits this statement explicitly. No list, mutation or secret permission is added, and the four-target prerequisite plan cannot provision these roles. Effective permissions and any provisioning require separate execution approval.

Only production's existing application role receives the four `ssmmessages`
channel actions. Their required `Resource = "*"` follows the
[message gateway authorization model](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssmmessages.html).
No general SSM session permission or secret-value read is granted.

Run the focused production identity source test and normal `terraform test`
discovery with backend-disabled initialization. Mocked tests establish source
policy shape, not live assumption, environment protection or runtime acceptance.
Keep concrete resource bindings, invocation envelopes and provider evidence private.
