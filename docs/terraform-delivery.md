# Terraform delivery

Terraform changes to `_infra` go through two manual workflows. Merges never apply Terraform.

Three properties hold for every change:

1. The Terraform role is assumable only through GitHub OIDC by the `Terraform Plan` and `Terraform Apply` workflows, from the `production` environment on `refs/heads/master` (Sandbox: the `sandbox` environment).
2. The environment's required reviewer approves every Apply before it starts.
3. Apply runs the exact saved plan that was reviewed, never a replan, and refuses if its commit or the encrypted plan's digest differs from the reviewed one.

Agents never approve a `Terraform Apply` run's environment gate. The standing permission for agents to approve production deploys does not extend to it. An agent may approve a `Terraform Plan` run, which runs in the same environment but holds only a read-only session.

## Plan, review, apply

1. **Plan.** Run `Terraform Plan` on `master` with the environment (`production` or `sandbox`; the workspace follows: `default` or `sandbox`). The job assumes the role with `ReadOnlyAccess` plus a session policy for the state lock and the secret reads a refresh needs, and runs one full `terraform plan -out` of `_infra`. If there are changes, it encrypts the saved plan and the Lambda archives with the environment secret `TERRAFORM_PLAN_PASSPHRASE` (AES-256, PBKDF2) and uploads only that encrypted file, kept for one day. A plan with no changes uploads nothing and cannot be applied.
2. **Review.** The run summary gives the commit SHA, the run attempt, the encrypted plan's SHA-256 (`plan_sha256`) and the counts to add, change, replace and destroy. Security-sensitive changes (IAM, KMS, bucket policies and public access blocks, security groups, Secrets Manager, GitHub environments and secrets) and every replace or destroy are flagged first, then every change. It shows addresses and actions only, never values. To read the full plan, see [Reading a plan locally](#reading-a-plan-locally).
3. **Apply.** Run `Terraform Apply` on `master` with the environment, the plan's run ID and its `plan_sha256`, then approve it. Apply checks that the run is a successful first-attempt `Terraform Plan` of the same environment on `master` in this repository, at the Apply's own commit, so a merge between plan and apply means planning again. In production it refuses while any `deploy.yml` run is open. It downloads the encrypted plan, refuses unless its SHA-256 equals `plan_sha256`, then decrypts and applies it.

Terraform output never reaches the public job log: init, plan, show and apply write to a log file that is uploaded encrypted with the same passphrase (`terraform-plan-log-<environment>` or `terraform-apply-log-<environment>`, one day). A failed step prints only its exit code.

Apply has its own `chronote-terraform-<environment>` concurrency group, so a merge deploy cannot displace a queued Apply. Each backend deploy first waits up to 60 minutes while an Apply of its environment is running (`waitForApplyIdle` in `scripts/deployment/terraform-runs.cjs`, which reads the environment from the run name `Terraform Apply <environment> plan=<id> ...`). Both checks are snapshots, so a deploy and an Apply that start within one poll of each other can still overlap.

Inputs: `TERRAFORM_TFVARS_JSON` plus `TFVAR_<KEY>` variable overrides, rendered by `scripts/deployment/terraform-tfvars.py`, which refuses credentials through the variable path. `REDIS_AUTH_TOKEN` and `REDIS_URL` secrets overlay the tfvars. Each environment also needs `TERRAFORM_AWS_ROLE_ARN`, `AWS_ACCOUNT_ID` and the secret `TERRAFORM_PLAN_PASSPHRASE`.

The `production` environment's required reviewer, `master`-only branch policy and bypass setting are set by hand. Terraform manages the environment but ignores those settings, so no plan changes them.

## Reading a plan locally

The passphrase belongs to the owner: generate it, keep it in a password manager, and set each environment's secret from there. To read a plan, check out the plan's commit and run:

```sh
read -rs TERRAFORM_PLAN_PASSPHRASE && export TERRAFORM_PLAN_PASSPHRASE
gh run download <plan run id> -n terraform-plan-production -D "$TMPDIR/plan"
sha256sum "$TMPDIR/plan/plan.tgz.enc"   # must equal plan_sha256
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:TERRAFORM_PLAN_PASSPHRASE \
  -in "$TMPDIR/plan/plan.tgz.enc" | tar -xz -C _infra
terraform -chdir=_infra init -backend=false -lockfile=readonly
terraform -chdir=_infra show tfplan
rm -f _infra/tfplan _infra/*.zip && rm -rf "$TMPDIR/plan"
```

The plan holds every variable value, credentials included, so delete it afterwards. Read a log the same way: download `terraform-plan-log-production` and decrypt `terraform.log.enc` to the terminal.

## What the production role may do

`_infra/production-bootstrap` owns the role `meeting-notes-prod-github-terraform` and its permissions. **Held by an approved Apply, the role is close to account administrator.** Its controls are the workflow-pinned OIDC trust, the `master` ref and the owner's approval. The policies below limit accidents, not an approved plan.

- **Read:** the AWS managed `ReadOnlyAccess` policy, enough for a full plan.
- **Write**, one managed policy `meeting-notes-prod-terraform-delivery`: every action of the services `_infra` uses on resources named `meeting-notes-prod-*` and the legacy `/vpc/flow/app-vpc` log group; the resource types whose ARNs carry generated IDs (VPC networking, CloudFront, ACM, Route 53 records, AppConfig, AMP, AMG, ElastiCache, cost categories, task definitions, creating a KMS key) on any resource; KMS key policy, grants and use only on keys tagged `Environment = prod`, which the application key carries through the provider's default tags; IAM writes and `iam:PassRole` on `role/meeting-notes-prod-*`, `role/vpc_flow_logs_role` and `policy/meeting-notes-prod-*`, attaching only those policies and the three AWS managed policies `_infra` uses; the application state object and its lock entries.
- **Denied**, in the role's inline policy: changing the role itself, any `meeting-notes-prod-terraform*` policy or the GitHub OIDC provider; trust, inline policy, attachment and `iam:PassRole` on any role outside the application; attaching `AdministratorAccess`, `IAMFullAccess` or `PowerUserAccess`; writing either bootstrap root's state; reading table items or bucket objects of `meeting-notes-prod-*`; and any action on a resource tagged `Environment = sandbox`, since Sandbox shares the account.

The managed policy renders at about 3,600 of IAM's 6,144 characters and the inline policy at about 1,500 of 10,240. The bootstrap tftest asserts both limits, the trust, that no IAM write has a wildcard resource, the KMS tag condition and the denies.

Known gaps: Sandbox resources that cannot carry tags (CloudFront origin access controls, functions and response headers policies, Route 53 records in a shared zone, AppConfig hosted configuration versions) are reachable through the generated-ID grants. A full plan with exactly this policy has not run yet; an `AccessDenied` names the missing action, which goes into `terraform-role.tf`.

## One-time migration

1. **Merge** this change after the deploy-on-merge change it stacks on.
2. **Set the passphrase**: generate one (for example `openssl rand -base64 48`), save it in the password manager, and set it from there with `gh secret set TERRAFORM_PLAN_PASSPHRASE --env production`, then the same for `sandbox`.
3. **Apply the bootstrap root as an administrator**, from a clean `master` checkout with Terraform 1.16.0 and the private bootstrap tfvars (remove the deleted inputs `production_certificate_arn`, `production_hosted_zone_id`, `frontend_distribution_id`, `docs_distribution_id` and the four `enable_*_policy` flags):

   ```sh
   cd _infra/production-bootstrap
   terraform init -input=false -lockfile=readonly
   terraform plan -input=false -var-file=<private-bootstrap.tfvars> -out=bootstrap.tfplan
   terraform show bootstrap.tfplan
   terraform apply bootstrap.tfplan
   rm bootstrap.tfplan
   ```

   The plan should create `aws_iam_policy.production_terraform_delivery[0]` and the attachments `production_terraform_delivery[0]` and `production_terraform_read_only[0]`, and update in place `aws_iam_role_policy.production_terraform[0]` and `aws_iam_role.production_terraform[0]` (its trust gains the workflow claim). It must not replace or destroy the role or any of the six `private_evidence` resources. If the artifact-preservation or alerting-delivery policies were ever applied through this root, their destroy is expected; anything else being destroyed is a stop.

4. **Remove the two hand-installed policies**, which are not in this root's state:

   ```sh
   for name in processing-retry site-delivery; do
     arn="arn:aws:iam::<account>:policy/meeting-notes-prod-terraform-$name"
     aws iam detach-role-policy --role-name meeting-notes-prod-github-terraform --policy-arn "$arn"
     aws iam delete-policy --policy-arn "$arn"
   done
   ```

   `delete-policy` fails while non-default versions exist; delete those with `delete-policy-version` first. Optionally delete the unused `TERRAFORM_PLAN_REFERENCE_JSON` secret and `PRODUCTION_APPLY_ROLE_ARN` variable from `production`. Keep `TERRAFORM_PRIVATE_STORAGE_JSON`: the site publishing jobs in `deploy.yml` read the account binding from it. `AWS_TOKEN_KEY` can be dropped from the tfvars secret whenever it is next edited; the renderer already ignores it.

5. **Run the first full production plan**: `gh workflow run terraform-plan.yml --ref master -f environment=production`, then approve its job. Production has only ever received scoped plans, so expect pending changes that never shipped through them: CloudFront routing, the history table's retry index (and its delivery index if still missing), alarms and ALB access logs, the deploy and prompt guard roles, `production-deploy` variables and similar. Expect one destroy: the `AWS_ACCESS_KEY_ID` GitHub variable (`github_actions_environment_variable.envvar_aws_access_key_id`), which nothing reads. Read every flagged line; a replace of a table, bucket, distribution, the load balancer, the KMS key or a GitHub environment, or any change to the `production` environment's protection, is a stop.
6. **Approve the Apply**: `gh workflow run terraform-apply.yml --ref master -f environment=production -f plan_run_id=<run id> -f plan_sha256=<digest>`.

## Sandbox

The workflows accept `sandbox`, but the Sandbox Terraform role in `_infra/sandbox-bootstrap` still has the old narrow policy, so a full Sandbox plan is denied, and its trust has no workflow claim. It needs the same shape as production: the workflow claim, `ReadOnlyAccess`, a `meeting-notes-sandbox-` write policy, and denies for its own identity and for resources tagged `Environment = prod`, applied by an administrator, plus `TERRAFORM_PLAN_PASSPHRASE` in the `sandbox` environment.
