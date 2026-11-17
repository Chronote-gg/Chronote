mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:role/Administrator" } }
  mock_data "aws_kms_key" { defaults = { aws_account_id = "123456789012", arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", key_state = "Enabled" } }
  mock_data "aws_iam_openid_connect_provider" { defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com", url = "token.actions.githubusercontent.com", client_id_list = ["sts.amazonaws.com"] } }
}
variables {
  sandbox_account_id     = "123456789012"
  kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111"
  administrator_role_arn = "arn:aws:iam::123456789012:role/Administrator"
  reviewer_role_arn      = "arn:aws:iam::123456789012:role/PrivateReader"
  trusted_refs           = ["refs/heads/codex/sandbox-terraform-capture", "refs/heads/master"]
  github_repository_id   = "123456"
  github_owner_id        = "654321"
  site_frontend_bucket   = "meeting-notes-sandbox-frontend-123456789012"
  site_docs_bucket       = "meeting-notes-sandbox-docs-123456789012"
}
override_resource {
  target          = aws_iam_role.sandbox_terraform
  values          = { arn = "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-terraform" }
  override_during = plan
}
run "migration_requires_existing_role" {
  command = plan
  variables { enable_sandbox_terraform_delivery = true }
  expect_failures = [var.enable_sandbox_terraform_delivery]
}
run "delivery_parity" {
  command = plan
  variables {
    enable_private_evidence_store     = true
    enable_sandbox_terraform_role     = true
    enable_sandbox_terraform_delivery = true
  }
  assert {
    condition     = aws_iam_role.sandbox_terraform[0].name == "meeting-notes-sandbox-github-terraform" && aws_iam_role_policy.sandbox_terraform[0].name == "meeting-notes-sandbox-terraform-prerequisites" && aws_iam_role.sandbox_terraform_plan[0].name == "meeting-notes-sandbox-github-terraform-plan"
    error_message = "Migration keeps installed Apply identities and adds only the separate Plan identity."
  }
  assert {
    condition     = alltrue([for binding in [{ role = aws_iam_role.sandbox_terraform[0], workflow = "Terraform Apply" }, { role = aws_iam_role.sandbox_terraform_plan[0], workflow = "Terraform Plan" }] : jsondecode(binding.role.assume_role_policy).Statement[0].Condition.StringEquals == { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:Chronote-gg/Chronote:environment:sandbox", "token.actions.githubusercontent.com:repository_id" = var.github_repository_id, "token.actions.githubusercontent.com:repository_owner_id" = var.github_owner_id, "token.actions.githubusercontent.com:ref" = "refs/heads/master", "token.actions.githubusercontent.com:workflow" = binding.workflow }])
    error_message = "Both roles pin the exact workflow, master, existing Sandbox environment and immutable repository identities."
  }
  assert {
    condition     = aws_iam_role.sandbox_terraform[0].max_session_duration == 7200 && aws_iam_role.sandbox_terraform_plan[0].max_session_duration == 3600 && length(local.delivery_policy) <= 6144 && length(local.delivery_guardrails) <= 10240
    error_message = "Session lengths cover existing workflow bounds and policies fit IAM limits."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.sandbox_terraform_read_only[0].policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess" && aws_iam_role_policy_attachment.sandbox_terraform_plan_read_only[0].policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess" && local.plan_store_statement.Resource == "arn:aws:s3:::${local.state_bucket}/terraform-plans/sandbox/*" && local.plan_store_statement.Condition.StringEquals["s3:if-none-match"] == "*"
    error_message = "Both roles read refresh metadata and only create write-once Sandbox plan objects."
  }
  assert {
    condition     = alltrue([for policy in [local.delivery_guardrails, aws_iam_role_policy.sandbox_terraform_plan[0].policy] : one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionResources"]).Condition.StringEquals["aws:ResourceTag/Environment"] == "prod" && one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionNamedResources"]).Effect == "Deny" && one([for s in jsondecode(policy).Statement : s if s.Sid == "StateReadsOnlySandbox"]).Effect == "Deny" && toset(one([for s in jsondecode(policy).Statement : s if s.Sid == "StateReadsOnlySandbox"]).NotResource) == toset(["arn:aws:s3:::${local.state_bucket}/${local.state_key}", "arn:aws:s3:::${local.state_bucket}/terraform-plans/sandbox/*"])])
    error_message = "ReadOnlyAccess must never expose production resources, shared production state or another environment's saved plans."
  }
  assert {
    condition = (one([for s in jsondecode(aws_iam_role_policy.sandbox_terraform_plan[0].policy).Statement : s if s.Sid == "SearchTagMetadata"]).Action == "s3vectors:ListTagsForResource" &&
      toset(one([for s in jsondecode(aws_iam_role_policy.sandbox_terraform_plan[0].policy).Statement : s if s.Sid == "SearchTagMetadata"]).Resource) == toset([
        "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-search-${var.sandbox_account_id}",
        "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-search-${var.sandbox_account_id}/index/*"
      ])
    )
    error_message = "Plan may read tags only on its exact Sandbox search bucket and retained-generation indexes, without vector content access."
  }
  assert {
    condition = alltrue([for policy in [local.delivery_guardrails, aws_iam_role_policy.sandbox_terraform_plan[0].policy] :
      contains(one([for s in jsondecode(policy).Statement : s if s.Sid == "CustomerData"]).Action, "dynamodb:GetRecords") &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "CustomerData"]).Effect == "Deny" &&
      contains(one([for s in jsondecode(policy).Statement : s if s.Sid == "CustomerData"]).Resource, "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-sandbox-*")
    ])
    error_message = "Terraform roles must deny customer stream records as well as table reads; the table wildcard covers its stream ARNs."
  }
  assert {
    condition = alltrue([for policy in [local.delivery_guardrails, aws_iam_role_policy.sandbox_terraform_plan[0].policy] :
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionResources"]).NotAction == "iam:GetOpenIDConnectProvider" &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionResources"]).Resource == "*" &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionOidcMetadata"]).Effect == "Deny" &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionOidcMetadata"]).Action == "iam:GetOpenIDConnectProvider" &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionOidcMetadata"]).NotResource == "arn:aws:iam::${var.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com" &&
      one([for s in jsondecode(policy).Statement : s if s.Sid == "ProductionOidcMetadata"]).Condition.StringEquals["aws:ResourceTag/Environment"] == "prod"
    ])
    error_message = "Only the exact shared GitHub OIDC metadata read bypasses the production tag deny; other reads and all writes remain denied."
  }
  assert {
    condition     = contains(one([for s in jsondecode(local.delivery_guardrails).Statement : s if s.Sid == "OwnIdentity"]).Resource, "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-terraform*") && one([for s in jsondecode(local.delivery_guardrails).Statement : s if s.Sid == "OwnIdentity"]).Effect == "Deny" && alltrue([for s in jsondecode(local.delivery_policy).Statement : !can(regex("iam:", jsonencode(s.Action))) || s.Resource != "*"])
    error_message = "Apply cannot edit its own policies, Plan identity or OIDC trust, and IAM writes never target a wildcard resource."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.sandbox_terraform_read_only) + length(aws_iam_policy.sandbox_terraform_delivery) + length(aws_iam_role_policy_attachment.sandbox_terraform_delivery) + length(aws_iam_role.sandbox_terraform_plan) + length(aws_iam_role_policy.sandbox_terraform_plan) + length(aws_iam_role_policy_attachment.sandbox_terraform_plan_read_only) == 6
    error_message = "Migration adds exactly the six delivery resources without replacing the private evidence store."
  }
}

run "legacy_delivery_disabled" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  assert {
    condition     = length(aws_iam_role.sandbox_terraform_plan) + length(aws_iam_policy.sandbox_terraform_delivery) + length(aws_iam_role_policy_attachment.sandbox_terraform_read_only) + length(aws_iam_role_policy_attachment.sandbox_terraform_delivery) == 0 && output.terraform_role_policy == local.legacy_terraform_role_policy && output.terraform_plan_role_arn == null
    error_message = "Without migration the installed eight-resource policy and strict saved-plan contract remain unchanged."
  }
}
