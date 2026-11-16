# Terraform delivery

Terraform changes to `_infra` go through two manual workflows. Merges never apply Terraform.

Three properties hold for every change:

1. The Terraform role is assumable only through GitHub OIDC from the `production` environment on `refs/heads/master` (Sandbox: the `sandbox` environment).
2. The environment's required reviewer approves every Apply before it starts. Agents never apply.
3. Apply runs the exact saved plan that was reviewed, never a replan, and refuses if its commit differs from the plan's.

## Plan, review, apply

1. **Plan.** Run `Terraform Plan` on `master` with the environment (`production` or `sandbox`; the workspace follows: `default` or `sandbox`). It runs one full `terraform plan -out` of `_infra`, encrypts the saved plan and the Lambda archives with the environment secret `TERRAFORM_PLAN_PASSPHRASE` (AES-256, PBKDF2), and uploads only that encrypted file as an artifact kept for one day. Plan text never reaches the log: the plan contains every variable value, credentials included.
2. **Review.** The run summary lists each changed resource address with its action, the counts to add, change, replace and destroy, the plan's commit SHA and the SHA-256 of the encrypted artifact. Replace and destroy lines are listed first. It never shows attribute values. Read every replace and destroy line before going on.
3. **Apply.** Run `Terraform Apply` on `master` with the environment and the plan's run ID, then approve it. Apply checks that the run is a successful `Terraform Plan` of the same environment on `master` in this repository and that its commit equals the Apply's checked-out commit. A merge between plan and apply therefore means planning again. In production it then refuses while any `deploy.yml` run is open. It downloads, decrypts and applies the saved plan file.

Apply has its own `chronote-terraform-<environment>` concurrency group, so a merge deploy cannot displace a queued Apply. Each backend deploy first waits up to 60 minutes while an Apply of its environment is running (`waitForApplyIdle` in `scripts/deployment/terraform-runs.cjs`, which reads the environment from the run name `Terraform Apply <environment> plan=<id>`). Both checks are snapshots, so a deploy and an Apply that start within one poll of each other can still overlap.

Inputs: `TERRAFORM_TFVARS_JSON` plus `TFVAR_<KEY>` variable overrides, rendered by `scripts/deployment/terraform-tfvars.py`, which refuses credentials through the variable path. `REDIS_AUTH_TOKEN` and `REDIS_URL` secrets overlay the tfvars. Each environment also needs `TERRAFORM_AWS_ROLE_ARN`, `AWS_ACCOUNT_ID` and the secret `TERRAFORM_PLAN_PASSPHRASE`.

## What the production role may do

`_infra/production-bootstrap` owns the role `meeting-notes-prod-github-terraform` and its permissions. Sandbox shares the AWS account, so the boundary is the `meeting-notes-prod-` name and the `Environment` tag.

- **Read:** the AWS managed `ReadOnlyAccess` policy, enough for a full plan.
- **Write**, one managed policy `meeting-notes-prod-terraform-delivery`:
  - every action of the services `_infra` uses on resources named `meeting-notes-prod-*` (tables, buckets, log groups, alarms, topics, functions, rules, repositories, ECS, load balancers, `meeting-notes-prod/*` secrets), plus the legacy `/vpc/flow/app-vpc` log group;
  - the resource types whose ARNs carry generated IDs (VPC networking, CloudFront, ACM, Route 53 records, AppConfig, AMP, AMG, ElastiCache, cost categories, task definitions and the KMS key), without a name limit;
  - IAM writes and `iam:PassRole` on `role/meeting-notes-prod-*`, `role/vpc_flow_logs_role` and `policy/meeting-notes-prod-*`; attaching only those policies and the three AWS managed policies `_infra` uses;
  - the application state object and its lock entries.
- **Denied**, in the role's inline policy: changing the role itself, any `meeting-notes-prod-terraform*` policy or the GitHub OIDC provider; writing either bootstrap root's state; reading table items or bucket objects of `meeting-notes-prod-*`; and any action on a resource tagged `Environment = sandbox`.

The managed policy renders at about 3,400 of IAM's 6,144 characters and the inline policy at about 940. The bootstrap tftest asserts both limits, that no IAM write has a wildcard resource, and that the denies exist.

Known gaps: Sandbox resources that cannot carry tags (CloudFront origin access controls, functions and response headers policies, Route 53 records in a shared zone, AppConfig hosted configuration versions) are reachable through the generated-ID grants. A full plan with exactly this policy has not run yet; an `AccessDenied` names the missing action, which goes into `terraform-role.tf`.

## One-time migration

1. **Merge** this change after the deploy-on-merge change it stacks on.
2. **Set the passphrase** in each environment, for example `openssl rand -base64 48 | gh secret set TERRAFORM_PLAN_PASSPHRASE --env production`, and the same for `sandbox`.
3. **Apply the bootstrap root as an administrator**, from a clean `master` checkout with Terraform 1.16.0 and the private bootstrap tfvars (remove the deleted inputs `production_certificate_arn`, `production_hosted_zone_id`, `frontend_distribution_id`, `docs_distribution_id` and the four `enable_*_policy` flags):

   ```sh
   cd _infra/production-bootstrap
   terraform init -input=false -lockfile=readonly
   terraform plan -input=false -var-file=<private-bootstrap.tfvars> -out=bootstrap.tfplan
   terraform show bootstrap.tfplan
   terraform apply bootstrap.tfplan
   rm bootstrap.tfplan
   ```

   The plan should create `aws_iam_policy.production_terraform_delivery[0]` and the attachments `production_terraform_delivery[0]` and `production_terraform_read_only[0]`, and update `aws_iam_role_policy.production_terraform[0]` in place. It must not change, replace or destroy `aws_iam_role.production_terraform[0]` or any of the six `private_evidence` resources. If the artifact-preservation or alerting-delivery policies were ever applied through this root, their destroy is expected; anything else being destroyed is a stop.

4. **Remove the two hand-installed policies**, which are not in this root's state:

   ```sh
   for name in processing-retry site-delivery; do
     arn="arn:aws:iam::<account>:policy/meeting-notes-prod-terraform-$name"
     aws iam detach-role-policy --role-name meeting-notes-prod-github-terraform --policy-arn "$arn"
     aws iam delete-policy --policy-arn "$arn"
   done
   ```

   `delete-policy` fails while non-default versions exist; delete those with `delete-policy-version` first. Optionally delete the unused `TERRAFORM_PLAN_REFERENCE_JSON` secret and `PRODUCTION_APPLY_ROLE_ARN` variable from `production`. Keep `TERRAFORM_PRIVATE_STORAGE_JSON`: the site publishing jobs in `deploy.yml` read the account binding from it.

5. **Run the first full production plan**: `gh workflow run terraform-plan.yml --ref master -f environment=production`, then approve its job. Production has only ever received scoped plans, so expect pending changes that never shipped through them: CloudFront routing, the history table's retry index (and its delivery index if still missing), alarms and ALB access logs, the deploy and prompt guard roles, `production-deploy` variables and similar. Read every replace and destroy line; a replace of a table, bucket, distribution, the load balancer, the KMS key or a GitHub environment is a stop.
6. **Approve the Apply**: `gh workflow run terraform-apply.yml --ref master -f environment=production -f plan_run_id=<run id>`.

## Sandbox

The workflows accept `sandbox`, but the Sandbox Terraform role in `_infra/sandbox-bootstrap` still has the old narrow policy, so a full Sandbox plan is denied. It needs the same shape as production: `ReadOnlyAccess`, a `meeting-notes-sandbox-` write policy, and denies for its own identity and for resources tagged `Environment = prod`, applied by an administrator, plus `TERRAFORM_PLAN_PASSPHRASE` in the `sandbox` environment.
