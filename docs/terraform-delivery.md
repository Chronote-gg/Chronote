# Terraform delivery

Terraform changes to `_infra` go through two manual workflows. Merges never apply Terraform.

Three properties hold for every change:

1. Production Terraform uses two roles, each assumable only through GitHub OIDC on `refs/heads/master`. The Plan role trusts only the `Terraform Plan` workflow in the `production` environment and can only read. The Apply role trusts only the `Terraform Apply` workflow in the `production-terraform` environment.
2. `production-terraform` is created by hand, never by Terraform, with the owner as its only required reviewer, so every production Apply waits for the owner and no plan or workflow can weaken that gate. The separate environment keeps Apply approvals out of the standing permission for agents to approve production deployments, which pend in `production` along with Plan runs. It does not stop an agent by identity: agents on the owner's machine run `gh` as the owner's own account, which is the sole reviewer, and self-review is allowed, so an agent could technically approve an Apply. "Agents never approve a `Terraform Apply`" therefore remains a rule. The structural fix is a separate GitHub identity for agents (a machine account or GitHub App without reviewer rights); that is an owner follow-up.
3. Apply runs the exact saved plan that was reviewed, never a replan, and refuses if its commit or the stored plan bundle's digest differs from the reviewed one.

Sandbox keeps one role and runs both workflows in the `sandbox` environment: it holds no customer data, and its bootstrap root is still the older narrow design (see [Sandbox](#sandbox)).

## Plan, review, apply

1. **Plan.** Run `Terraform Plan` on `master` with the environment (`production` or `sandbox`; the workspace follows: `default` or `sandbox`). It runs one full `terraform plan -out` of `_infra`. If there are changes, it writes the saved plan and the Lambda archives as one bundle to the Terraform state bucket at `terraform-plans/<environment>/<run id>-<attempt>/plan.tar.gz`. The state bucket is private and already holds the credentials in state; the plan adds no secret to manage, but see [who can read stored plans](#who-can-read-stored-plans). Each key is written once (`If-None-Match`) and never replaced. A plan with no changes stores nothing and cannot be applied.
2. **Review.** The run summary gives the commit SHA, the run attempt, the bundle's S3 key and SHA-256 (`plan_sha256`), and the counts to add, change, replace and destroy. Security-sensitive changes (IAM, KMS, bucket policies and public access blocks, security groups, Secrets Manager, GitHub environments and secrets) and every replace or destroy are flagged first, then every change. It shows addresses and actions only, never values. To read the full plan, see [Reading a plan locally](#reading-a-plan-locally).
3. **Apply.** Run `Terraform Apply` on `master` with the environment, the plan's run ID and its `plan_sha256`, then approve it in `production-terraform`. Apply checks that the run is a successful first-attempt `Terraform Plan` of the same environment on `master` in this repository, at the Apply's own commit, so a merge between plan and apply means planning again. In production it refuses while any `deploy.yml` run is open. It downloads the bundle from the state bucket, refuses unless its SHA-256 equals `plan_sha256`, then unpacks and applies it.

Terraform output never reaches the public job log: init, plan, show and apply write to a log file stored beside the plan (`terraform.log` for the plan, `apply-<run id>-<attempt>.log` for each Apply). A failed step prints only its exit code. A failed log upload only warns: it never fails the Plan or Apply job.

Apply has its own `chronote-terraform-<environment>` concurrency group, so a merge deploy cannot displace a queued Apply. Each backend deploy first waits up to 60 minutes while an Apply of its environment is running (`waitForApplyIdle` in `scripts/deployment/terraform-runs.cjs`, which reads the environment from the run name `Terraform Apply <environment> plan=<id> ...`). Both checks are snapshots, so a deploy and an Apply that start within one poll of each other can still overlap.

Settings per environment:

- `production` (Plan): variables `TERRAFORM_AWS_ROLE_ARN` (the Plan role) and `AWS_ACCOUNT_ID`; secret `TERRAFORM_TFVARS_JSON`, and optionally `REDIS_AUTH_TOKEN` and `REDIS_URL`, which overlay the tfvars. `TFVAR_<KEY>` variables override tfvars keys through `scripts/deployment/terraform-tfvars.py`, which refuses credentials on that path. Its reviewer, branch policy and bypass setting are set by hand; Terraform manages the environment but ignores those settings.
- `production-terraform` (Apply): variables `TERRAFORM_AWS_ROLE_ARN` (the Apply role) and `AWS_ACCOUNT_ID`. No secret: the saved plan carries every variable value.
- `sandbox`: as `production`, with the Sandbox role for both workflows.

## Who can read stored plans

Anyone who can read the state bucket could already read every credential in state. A saved plan also holds every input variable value, including ones no resource stores, so it additionally exposes those to the same readers for as long as the object exists (at most 30 days plus a day for the old version, see below): the GitHub provider token (`GITHUB_TOKEN`, which only configures the provider), and `REDIS_AUTH_TOKEN` when ElastiCache is off (it then feeds nothing). Those readers are the two Terraform roles (through `ReadOnlyAccess`), the account administrators, and any other principal in this AWS account with S3 read on the bucket; the account is shared with other products, so the repository cannot list them.

**Stored plans expire after 30 days, and the Plan job enforces it.** Before it plans or stores anything, the job reads the state bucket's lifecycle configuration and refuses unless an enabled rule covering `terraform-plans/` expires current objects and noncurrent versions (the bucket is versioned, so expiring the current version alone only adds a delete marker and keeps the plan bytes). No configuration at all is a refusal too. `put-bucket-lifecycle-configuration` replaces the whole configuration, so the rule is added by reading the current one and merging, which works whether or not the bucket has one. An administrator runs once:

```sh
bash -euo pipefail <<'EOF'
bucket=meeting-notes-terraform-state-bucket
if ! current=$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" 2> /tmp/lifecycle.err); then
  grep -q NoSuchLifecycleConfiguration /tmp/lifecycle.err || { cat /tmp/lifecycle.err; exit 1; }
  current='{"Rules":[]}'
fi
jq '{Rules: ([.Rules[] | select(.ID != "expire-terraform-plans")] + [{ID: "expire-terraform-plans", Filter: {Prefix: "terraform-plans/"}, Status: "Enabled", Expiration: {Days: 30}, NoncurrentVersionExpiration: {NoncurrentDays: 1}}])}' <<< "$current" > /tmp/lifecycle.json
aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration file:///tmp/lifecycle.json
aws s3api get-bucket-lifecycle-configuration --bucket "$bucket"
EOF
```

The last command must show every earlier rule plus `expire-terraform-plans`. The bucket is managed by `_infra_state_mgmt`, whose committed local state is stale, so the rule is not added there.

Optional hardening: deny reading stored plans to everyone except the two Terraform roles and the administrator role. Merge this statement into the bucket policy (`put-bucket-policy` replaces the whole policy, so read the current one with `get-bucket-policy` first):

```json
{
  "Sid": "PlansOnlyForTerraform",
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/*",
  "Condition": {
    "ArnNotLike": {
      "aws:PrincipalArn": [
        "arn:aws:iam::<account>:role/meeting-notes-prod-github-terraform",
        "arn:aws:iam::<account>:role/meeting-notes-prod-github-terraform-plan",
        "<administrator role ARN>"
      ]
    }
  }
}
```

## Reading a plan locally

With the administrator AWS login, from a checkout of the plan's commit:

```sh
key=terraform-plans/production/<plan run id>-1
aws s3 cp "s3://meeting-notes-terraform-state-bucket/$key/plan.tar.gz" "$TMPDIR/plan.tar.gz"
sha256sum "$TMPDIR/plan.tar.gz"   # must equal plan_sha256
tar -xzf "$TMPDIR/plan.tar.gz" -C _infra
terraform -chdir=_infra init -backend=false -lockfile=readonly
terraform -chdir=_infra show tfplan
rm -f _infra/tfplan _infra/*.zip "$TMPDIR/plan.tar.gz"
```

The plan holds every variable value, credentials included, so delete the local copy afterwards. Read a log with `aws s3 cp s3://meeting-notes-terraform-state-bucket/$key/terraform.log -`.

## What the production roles may do

`_infra/production-bootstrap` owns both roles.

The **Plan role** `meeting-notes-prod-github-terraform-plan` has the AWS managed `ReadOnlyAccess` policy plus exactly the state lock writes and the secret reads a refresh needs, and is denied reading table items or bucket objects of `meeting-notes-prod-*`. Nothing else. A refresh reads Terraform state, which holds secrets, so approving a Plan run grants read access to those secrets for that run.

The **Apply role** `meeting-notes-prod-github-terraform` is close to account administrator. Its controls are its OIDC trust (the `Terraform Apply` workflow, `master`, `production-terraform`) and the owner's approval. Its IAM denies limit accidents, not a determined Apply: it may write inline policies on any `meeting-notes-prod-*` role, and IAM cannot constrain what those policies say.

- **Read:** `ReadOnlyAccess`.
- **Write**, one managed policy `meeting-notes-prod-terraform-delivery`: every action of the services `_infra` uses on resources named `meeting-notes-prod-*` and the legacy `/vpc/flow/app-vpc` log group; the resource types whose ARNs carry generated IDs (VPC networking, CloudFront, ACM, Route 53 records, AppConfig, AMP, AMG, ElastiCache, cost categories, task definitions) on any resource; creating a KMS key only with `Environment = prod` in the request, and key policy, grants and use only on keys tagged `Environment = prod`, which the application key carries through the provider's default tags; IAM writes and `iam:PassRole` on `role/meeting-notes-prod-*`, `role/vpc_flow_logs_role` and `policy/meeting-notes-prod-*`, attaching only those policies and the three AWS managed policies `_infra` uses; the application state object and its lock entries.
- **Denied**, in its inline policy: changing either Terraform role, any `meeting-notes-prod-terraform*` policy or the GitHub OIDC provider; trust, inline policy, attachment and `iam:PassRole` on any role outside the application; attaching `AdministratorAccess`, `IAMFullAccess` or `PowerUserAccess`; writing either bootstrap root's state; reading table items or bucket objects of `meeting-notes-prod-*`; and any action on a resource tagged `Environment = sandbox`, since Sandbox shares the account.

The bootstrap tftest asserts both policy size limits, both trusts, that no IAM write has a wildcard resource, the KMS tag conditions and the denies.

Known gaps: Sandbox resources that cannot carry tags (CloudFront origin access controls, functions and response headers policies, Route 53 records in a shared zone, AppConfig hosted configuration versions) are reachable through the generated-ID grants. A full plan and apply with exactly these policies have not run yet; an `AccessDenied` names the missing action, which goes into `terraform-role.tf`.

The trusts pin the workflow by name (`token.actions.githubusercontent.com:workflow`). `job_workflow_ref` is a supported IAM key, but GitHub documents it only for jobs that call a reusable workflow, so it is not relied on.

## One-time migration

Nine steps. Five need the owner's own hands (**owner**, one of them optional): merging, the administrator AWS work, approving the Apply and the metrics check. Four an agent with `gh` can run once the owner says go (**agent**); none of them weakens a gate. Steps 7 to 9 run back to back, because until the deploy finishes the two heartbeat alarms are in ALARM.

1. **Owner: merge** this change.
2. **Agent: create `production-terraform`** with `gh`, never with Terraform. Required reviewer: the owner only. Admins cannot bypass. Branch policy: `master` only. No wait timer. Self-review stays allowed, because the owner both dispatches and approves.

   ```sh
   repo=repos/Chronote-gg/Chronote
   owner_id=$(gh api users/<owner login> --jq .id)
   account=<account id>
   gh api -X PUT "$repo/environments/production-terraform" --input - <<EOF
   {"reviewers":[{"type":"User","id":$owner_id}],"can_admins_bypass":false,"prevent_self_review":false,"wait_timer":0,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   EOF
   gh api -X POST "$repo/environments/production-terraform/deployment-branch-policies" -f name=master -f type=branch
   gh variable set TERRAFORM_AWS_ROLE_ARN --env production-terraform --body "arn:aws:iam::$account:role/meeting-notes-prod-github-terraform"
   gh variable set AWS_ACCOUNT_ID --env production-terraform --body "$account"
   gh api "$repo/environments/production-terraform" --jq '{can_admins_bypass, deployment_branch_policy, rules: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}]}'
   gh api "$repo/environments/production-terraform/deployment-branch-policies" --jq '[.branch_policies[].name]'
   ```

   The last two commands must show one `required_reviewers` rule naming only the owner, a `branch_policy` rule, `can_admins_bypass: false` and the single policy `master`.

3. **Owner: apply the bootstrap root as an administrator**, from a clean `master` checkout with Terraform 1.16.0 and the private bootstrap tfvars (remove the deleted inputs `production_certificate_arn`, `production_hosted_zone_id`, `frontend_distribution_id`, `docs_distribution_id` and the four `enable_*_policy` flags):

   ```sh
   cd _infra/production-bootstrap
   terraform init -input=false -lockfile=readonly
   terraform plan -input=false -var-file=<private-bootstrap.tfvars> -out=bootstrap.tfplan
   terraform show bootstrap.tfplan
   terraform apply bootstrap.tfplan
   terraform output terraform_plan_role_arn
   rm bootstrap.tfplan
   ```

   The plan should create `aws_iam_policy.production_terraform_delivery[0]`, the attachments `production_terraform_delivery[0]` and `production_terraform_read_only[0]`, and the Plan role `aws_iam_role.production_terraform_plan[0]` with `aws_iam_role_policy.production_terraform_plan[0]` and `aws_iam_role_policy_attachment.production_terraform_plan_read_only[0]`. It should update in place `aws_iam_role_policy.production_terraform[0]` and `aws_iam_role.production_terraform[0]` (its trust moves to `production-terraform` and the Apply workflow). It must not replace or destroy that role or any of the six `private_evidence` resources. If the artifact-preservation or alerting-delivery policies were ever applied through this root, their destroy is expected; anything else being destroyed is a stop.

   In the same session, remove the two hand-installed policies, which are not in this root's state (`delete-policy` fails while non-default versions exist; delete those with `delete-policy-version` first):

   ```sh
   for name in processing-retry site-delivery; do
     arn="arn:aws:iam::<account>:policy/meeting-notes-prod-terraform-$name"
     aws iam detach-role-policy --role-name meeting-notes-prod-github-terraform --policy-arn "$arn"
     aws iam delete-policy --policy-arn "$arn"
   done
   ```

   In the same session, add the 30-day plan expiry rule from [who can read stored plans](#who-can-read-stored-plans). This is required: until it exists every Plan run refuses before planning.

4. **Agent: point `production` at the Plan role**: `gh variable set TERRAFORM_AWS_ROLE_ARN --env production --body <terraform_plan_role_arn>`.
5. **Owner, optional cleanup at any time:** no workflow reads these, so they are safe to delete: in `production`, the secrets `TERRAFORM_PLAN_REFERENCE_JSON`, `BOOTSTRAP_VERIFICATION_STORAGE_JSON`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and the variables `PRODUCTION_APPLY_ROLE_ARN` and `AWS_ACCESS_KEY_ID` (the first Apply deletes that variable anyway); the secret `TERRAFORM_PLAN_PASSPHRASE` in `production`, `production-terraform` or `sandbox` if it was ever set; in the repository settings, the repository-level secret `AWS_SECRET_ACCESS_KEY`. If the static access key behind them still exists in IAM, deactivate and delete it too. Keep `TERRAFORM_PRIVATE_STORAGE_JSON`: the site publishing jobs in `deploy.yml` read the account binding from it. `AWS_TOKEN_KEY` can be dropped from the tfvars secret whenever it is next edited; the renderer already ignores it.
6. **Agent: run the first full production plan**: `gh workflow run terraform-plan.yml --ref master -f environment=production`, and approve its job. Production has only ever received scoped plans, so expect pending changes that never shipped through them: CloudFront routing, the history table's retry index (and its delivery index if still missing), the lifecycle alarms, alarms and ALB access logs, the deploy and prompt guard roles, a new task definition revision with `METRICS_NAMESPACE`, 60 GiB of ephemeral storage and no `LIVE_VOICE_GATE_MODEL` (the code default, `gpt-5-mini` today, applies instead; the tfvars renderer drops a leftover `LIVE_VOICE_GATE_MODEL` key; step 7 checks the running value) (the running task gets both only at the deploy in step 8), the disk alarms' thresholds moving to 75 and 95 percent of the larger disk, `production-deploy` variables and similar. GitHub variables Terraform writes but `production` may hold only by hand (today `VITE_API_BASE_URL` and `ECS_LOG_GROUP` exist there; the Algolia variables only if their tfvars are set) show as `create` if they are not in state, and creating a variable that already exists fails the Apply. Before applying, compare each such value with the existing one (`gh variable get <name> --env production`); if it matches, delete the hand-set variable just before the Apply so Terraform recreates it. `VITE_API_BASE_URL` becomes `https://<API_DOMAIN>` from the tfvars, and the next frontend build bakes in whatever the variable holds, so it changes the frontend only if that differs from today's value. Destroys to expect: the `AWS_ACCESS_KEY_ID` GitHub variable (`github_actions_environment_variable.envvar_aws_access_key_id`), which nothing reads. Lifecycle `aws_cloudwatch_log_metric_filter` destroys: none expected; if any appear, they are the six lifecycle filters and are fine.
7. **Owner: check, then approve the Apply.** Before the first approval, run the two verification reads from step 2 yourself; they must show one `required_reviewers` rule naming only you, a `branch_policy` rule, `can_admins_bypass: false` and the single policy `master`. Then check the running live voice gate model, because the Apply drops its Terraform pin and the next deploy falls back to the code default (`gpt-5-mini` today); this has not been checked against production yet:

   ```sh
   aws ecs describe-task-definition --task-definition meeting-notes-prod-bot-task --query "taskDefinition.containerDefinitions[0].environment[?name=='LIVE_VOICE_GATE_MODEL'].value" --output text
   ```

   It must print `gpt-5-mini`; anything else is a stop until you decide which model the gate should use. Then read every flagged line in the plan summary; a replace of a table, bucket, distribution, the load balancer, the KMS key or a GitHub environment, or any change to the `production` environment's protection, is a stop. An agent may dispatch `gh workflow run terraform-apply.yml --ref master -f environment=production -f plan_run_id=<run id> -f plan_sha256=<digest>`; only you approve it in `production-terraform`.

8. **Agent: deploy the backend straight after**: once the Apply job is running (past its idle check), dispatch `deploy.yml`. The deploy waits for the Apply to finish, then rolls out a task that has `METRICS_NAMESPACE`. The Apply creates the lifecycle alarms, and the running task publishes no lifecycle metric until it is replaced, so `no_eligible_worker` and `finisher_scan_missing` go to ALARM within five and ten minutes of the Apply and back to OK once the new task's heartbeats arrive. Expect those two ALARM and two OK emails.
9. **Owner (any AWS read session): confirm the metrics arrive** within ten minutes of the deploy. AWS documents extraction from any Embedded Metric Format line in a Standard log group, but not this exact path (ECS awslogs driver):

   ```sh
   aws cloudwatch list-metrics --namespace meeting-notes-prod/Lifecycle --query 'Metrics[].MetricName'
   aws cloudwatch get-metric-statistics --namespace AWS/Logs --metric-name EMFValidationErrors --dimensions Name=LogGroupName,Value=/ecs/meeting-notes-prod-bot --statistics Sum --start-time "$(date -u -d '-30 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" --period 300
   ```

   Expect `WorkerEligibleHeartbeat` and `FinisherScanCompleted` in the first list and no validation errors. If the metrics do not appear, the two heartbeat alarms stay in ALARM and the other lifecycle alarms cannot fire: search the log group for `"_aws"` to confirm the lines arrive whole, check the `AWS/Logs` `EMFParsingErrors` and `EMFValidationErrors` metrics, and take it to the owner. The fallback is metric filters on the readable lines, which the workers still log.

Rollback: once step 3 has moved the Apply role's trust to `production-terraform` and the Apply workflow, reverting the delivery change leaves no working Terraform delivery, because the old workflows run in `production` and the role no longer trusts them. Restore it by applying the bootstrap root again from the reverted source, as an administrator.

## Sandbox

The workflows accept `sandbox`, but the Sandbox Terraform role in `_infra/sandbox-bootstrap` still has the old narrow policy, so a full Sandbox plan is denied and it has no grant to store a plan under `terraform-plans/sandbox/`: Sandbox fails closed. Its trust pins no workflow either. It needs the same shape as production, applied by an administrator: a Plan role and an Apply role pinned to their workflows (with a hand-made `sandbox-terraform` environment if Sandbox applies should also need the owner), `ReadOnlyAccess`, write-once `PutObject` under `terraform-plans/sandbox/`, a `meeting-notes-sandbox-` write policy, and denies for its own identities and for resources tagged `Environment = prod`.
