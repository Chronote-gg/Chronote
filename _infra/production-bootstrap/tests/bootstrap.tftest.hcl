mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_kms_key" { defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", key_state = "Enabled" } }
  mock_data "aws_iam_openid_connect_provider" { defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" } }
}
run "default_off" {
  command = plan
  assert {
    condition     = length(aws_s3_bucket.private_evidence) == 0 && length(aws_iam_role.production_terraform) == 0 && length(data.aws_kms_key.existing) == 0
    error_message = "Default bootstrap must create nothing and read no existing key."
  }
}
variables {
  production_account_id  = "123456789012"
  kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111"
  administrator_role_arn = "arn:aws:iam::123456789012:role/Administrator"
  reviewer_role_arn      = "arn:aws:iam::123456789012:role/Administrator"
  github_repository_id   = "123456"
  github_owner_id        = "654321"
}
run "role_requires_store" {
  command = plan
  variables { enable_production_terraform_role = true }
  expect_failures = [var.enable_production_terraform_role]
}
run "production_only" {
  command = plan
  variables {
    enable_private_evidence_store = true
    environment                   = "sandbox"
  }
  expect_failures = [var.enable_private_evidence_store]
}
run "foreign_region" {
  command = plan
  variables {
    enable_private_evidence_store = true
    aws_region                    = "us-west-2"
  }
  expect_failures = [var.enable_private_evidence_store]
}
run "foreign_key" {
  command = plan
  variables {
    enable_private_evidence_store = true
    kms_key_arn                   = "arn:aws:kms:us-east-1:999999999999:key/11111111-1111-4111-8111-111111111111"
  }
  expect_failures = [var.kms_key_arn]
}
run "enabled" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
  }
  assert {
    condition     = length(aws_s3_bucket.private_evidence) + length(aws_s3_bucket_public_access_block.private_evidence) + length(aws_s3_bucket_ownership_controls.private_evidence) + length(aws_s3_bucket_versioning.private_evidence) + length(aws_s3_bucket_server_side_encryption_configuration.private_evidence) + length(aws_s3_bucket_policy.private_evidence) + length(aws_iam_role.production_terraform) + length(aws_iam_role_policy.production_terraform) + length(aws_iam_role_policy_attachment.production_terraform_read_only) + length(aws_iam_policy.production_terraform_delivery) + length(aws_iam_role_policy_attachment.production_terraform_delivery) + length(aws_iam_role.production_terraform_plan) + length(aws_iam_role_policy.production_terraform_plan) + length(aws_iam_role_policy_attachment.production_terraform_plan_read_only) == 14
    error_message = "Bootstrap owns the six evidence bucket resources and the role at their existing addresses, plus the Apply role's three policies and the Plan role with its two."
  }
  assert {
    condition     = aws_s3_bucket.private_evidence[0].force_destroy == false && aws_s3_bucket_public_access_block.private_evidence[0].block_public_acls && aws_s3_bucket_public_access_block.private_evidence[0].ignore_public_acls && aws_s3_bucket_public_access_block.private_evidence[0].block_public_policy && aws_s3_bucket_public_access_block.private_evidence[0].restrict_public_buckets && one(aws_s3_bucket_ownership_controls.private_evidence[0].rule).object_ownership == "BucketOwnerEnforced" && one(aws_s3_bucket_versioning.private_evidence[0].versioning_configuration).status == "Enabled"
    error_message = "Evidence privacy, ownership and versioning are required."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.private_evidence[0].rule).bucket_key_enabled == false && one(one(aws_s3_bucket_server_side_encryption_configuration.private_evidence[0].rule).apply_server_side_encryption_by_default).kms_master_key_id == var.kms_key_arn
    error_message = "Evidence must retain exact existing KMS object contexts."
  }
  assert {
    condition     = aws_iam_role.production_terraform[0].name == "meeting-notes-prod-github-terraform" && aws_iam_role_policy.production_terraform[0].name == "meeting-notes-prod-terraform-prerequisites"
    error_message = "The role and its inline policy keep their installed names, so neither is replaced."
  }
  assert {
    condition     = jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Chronote-gg/Chronote:environment:production-terraform" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/master" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_id"] == var.github_repository_id && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_owner_id"] == var.github_owner_id && aws_iam_role.production_terraform[0].max_session_duration == 3600
    error_message = "Apply trust must bind production-terraform, master and both immutable IDs for one hour."
  }
}
run "foreign_account" {
  command = plan
  variables { enable_private_evidence_store = true }
  override_data {
    target = data.aws_caller_identity.current[0]
    values = { account_id = "999999999999" }
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}
run "disabled_existing_key" {
  command = plan
  variables { enable_private_evidence_store = true }
  override_data {
    target = data.aws_kms_key.existing[0]
    values = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", key_state = "Disabled" }
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}
run "foreign_oidc_provider" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
  }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = { arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com" }
  }
  expect_failures = [aws_iam_role.production_terraform]
}
run "missing_repository_id" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
    github_repository_id             = ""
  }
  expect_failures = [var.github_repository_id]
}
run "missing_owner_id" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
    github_owner_id                  = ""
  }
  expect_failures = [var.github_owner_id]
}
run "runtime_cannot_review" {
  command = plan
  variables {
    enable_private_evidence_store = true
    reviewer_role_arn             = "arn:aws:iam::123456789012:role/meeting-notes-prod-ecs-task-app-role"
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}
run "policy_limits" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
  }
  assert {
    condition     = aws_iam_role_policy_attachment.production_terraform_read_only[0].policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess"
    error_message = "Plan reads come from the AWS managed ReadOnlyAccess policy."
  }
  assert {
    condition     = length(aws_iam_policy.production_terraform_delivery[0].policy) <= 6144 && length(aws_iam_role_policy.production_terraform[0].policy) <= 10240
    error_message = "The managed policy must fit the IAM 6,144 character limit and the inline policy the 10,240 limit."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : alltrue([
      for r in flatten([s.Resource]) : startswith(r, "arn:aws:iam::123456789012:role/meeting-notes-prod-") || startswith(r, "arn:aws:iam::123456789012:policy/meeting-notes-prod-") || r == "arn:aws:iam::123456789012:role/vpc_flow_logs_role" || r == "arn:aws:iam::123456789012:role/aws-service-role/*"
    ]) if anytrue([for a in flatten([s.Action]) : startswith(a, "iam:")])])
    error_message = "IAM writes, PassRole included, reach only meeting-notes-prod- roles and policies and the legacy flow log role, never a wildcard resource."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : contains(["GeneratedIdResources", "ProductionKeyCreation"], s.Sid) && !anytrue([for a in s.Action : startswith(a, "iam:") || startswith(a, "s3:") || startswith(a, "dynamodb:") || startswith(a, "sts:")]) if s.Resource == "*"])
    error_message = "Only the generated-ID and tag-bound key creation statements may use a wildcard resource, and they grant no IAM, S3, DynamoDB or STS action."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "IamAttachments"]).Condition.ArnLike["iam:PolicyARN"] == ["arn:aws:iam::123456789012:policy/meeting-notes-prod-*", "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy", "arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess", "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess"]
    error_message = "Roles may be given only application policies and the three AWS managed policies that _infra uses."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "OwnIdentity"]) == { Sid = "OwnIdentity", Effect = "Deny", NotAction = ["iam:Get*", "iam:List*"], Resource = ["arn:aws:iam::123456789012:role/meeting-notes-prod-github-terraform*", "arn:aws:iam::123456789012:policy/meeting-notes-prod-terraform*", "arn:aws:iam::123456789012:oidc-provider/*"] }
    error_message = "The Apply role must be denied changing itself, the Plan role, their policies and the GitHub OIDC provider."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "BootstrapState"]) == { Sid = "BootstrapState", Effect = "Deny", Action = ["s3:PutObject", "s3:DeleteObject*"], Resource = "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/*-bootstrap/*" }
    error_message = "The role must be denied writing either bootstrap root's state."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "SandboxResources"]) == { Sid = "SandboxResources", Effect = "Deny", Action = "*", Resource = "*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "sandbox" } } }
    error_message = "Sandbox shares the account, so the role must be denied every action on Sandbox-tagged resources."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s.Effect == "Deny"])
    error_message = "The inline policy holds only the guardrails."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform_plan[0].policy).Statement : s if s.Sid == "PlanStore"]) == { Sid = "PlanStore", Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/production/*", Condition = { StringEquals = { "s3:if-none-match" = "*" } } }
    error_message = "The Plan role may only create new objects under the production plans prefix, never overwrite one or write state."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "PlanStoreLogs"]) == { Sid = "PlanStoreLogs", Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/production/*", Condition = { StringEquals = { "s3:if-none-match" = "*" } } }
    error_message = "The Apply role may only create its log under the production plans prefix."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "ServiceLinkedRoles"]) == { Sid = "ServiceLinkedRoles", Effect = "Allow", Action = "iam:CreateServiceLinkedRole", Resource = "arn:aws:iam::123456789012:role/aws-service-role/*", Condition = { StringEquals = { "iam:AWSServiceName" = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "elasticache.amazonaws.com", "grafana.amazonaws.com"] } } }
    error_message = "Only the service-linked roles of services _infra uses may be created."
  }
  assert {
    condition     = jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Chronote-gg/Chronote:environment:production-terraform" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:workflow"] == "Terraform Apply" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/master"
    error_message = "Only the Terraform Apply workflow, in the hand-made production-terraform environment on master, may assume the Apply role."
  }
  assert {
    condition     = aws_iam_role.production_terraform_plan[0].name == "meeting-notes-prod-github-terraform-plan" && jsondecode(aws_iam_role.production_terraform_plan[0].assume_role_policy).Statement[0].Condition.StringEquals == { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:Chronote-gg/Chronote:environment:production", "token.actions.githubusercontent.com:repository_id" = var.github_repository_id, "token.actions.githubusercontent.com:repository_owner_id" = var.github_owner_id, "token.actions.githubusercontent.com:ref" = "refs/heads/master", "token.actions.githubusercontent.com:workflow" = "Terraform Plan" }
    error_message = "Only the Terraform Plan workflow, in production on master, may assume the Plan role."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.production_terraform_plan_read_only[0].policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess" && aws_iam_role_policy_attachment.production_terraform_plan_read_only[0].role == "meeting-notes-prod-github-terraform-plan"
    error_message = "The Plan role reads through ReadOnlyAccess."
  }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.production_terraform_plan[0].policy).Statement : s.Action if s.Effect == "Allow"])) == toset(["dynamodb:PutItem", "dynamodb:DeleteItem", "secretsmanager:GetSecretValue", "kms:Decrypt", "s3:PutObject"]) && one([for s in jsondecode(aws_iam_role_policy.production_terraform_plan[0].policy).Statement : s.Sid if s.Effect == "Deny"]) == "CustomerData"
    error_message = "Beyond ReadOnlyAccess the Plan role may only take the state lock, read secrets a refresh needs and store its plan, and is denied customer data."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "ProductionKeyCreation"]) == { Sid = "ProductionKeyCreation", Effect = "Allow", Action = ["kms:CreateKey", "kms:TagResource"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Environment" = "prod" } } }
    error_message = "A KMS key may be created only with the production Environment tag in the request."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : !anytrue([for a in flatten([s.Action]) : startswith(a, "kms:")]) || s.Sid == "ProductionKeyCreation" || s.Condition == { StringEquals = { "aws:ResourceTag/Environment" = "prod" } }])
    error_message = "KMS key use and key policy writes reach only keys tagged Environment = prod."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "RolesOutsideApplication"]) == { Sid = "RolesOutsideApplication", Effect = "Deny", Action = ["iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PassRole"], NotResource = ["arn:aws:iam::123456789012:role/meeting-notes-prod-*", "arn:aws:iam::123456789012:role/vpc_flow_logs_role"] }
    error_message = "Trust, inline policy, attachment and PassRole must be denied for any role outside the application."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "PrivilegedPolicies"]).Condition.ArnEquals["iam:PolicyARN"] == ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/IAMFullAccess", "arn:aws:iam::aws:policy/PowerUserAccess"]
    error_message = "Attaching administrator, IAM full or power user access must be denied."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "ApplicationState"]).Resource == "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/state" && one([for s in jsondecode(aws_iam_policy.production_terraform_delivery[0].policy).Statement : s if s.Sid == "ApplicationStateLocks"]).Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] == ["meeting-notes-terraform-state-bucket/meeting-notes-terraform/state", "meeting-notes-terraform-state-bucket/meeting-notes-terraform/state-md5"]
    error_message = "State and lock writes must exclude bootstrap and Sandbox keys."
  }
  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ConditionalCreateOnly"]).Condition.StringNotEquals["s3:if-none-match"] == "*" && one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ExactKMSKey"]).Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"] == var.kms_key_arn && one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ExactVersionReview"]).Resource == "arn:aws:s3:::meeting-notes-prod-private-evidence-123456789012/terraform/production/*"
    error_message = "The evidence bucket policy is unchanged."
  }
}
