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
run "enabled_exact_eight_resources" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  assert {
    condition     = length(aws_s3_bucket.private_evidence) + length(aws_s3_bucket_public_access_block.private_evidence) + length(aws_s3_bucket_ownership_controls.private_evidence) + length(aws_s3_bucket_versioning.private_evidence) + length(aws_s3_bucket_server_side_encryption_configuration.private_evidence) + length(aws_s3_bucket_policy.private_evidence) + length(aws_iam_role.sandbox_terraform) + length(aws_iam_role_policy.sandbox_terraform) == 8
    error_message = "Enabled bootstrap must contain exactly eight creates."
  }
  assert {
    condition     = output.bucket_name == aws_s3_bucket.private_evidence[0].bucket && output.terraform_role_arn == aws_iam_role.sandbox_terraform[0].arn && output.terraform_role_arn == "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-terraform"
    error_message = "Enabled identity outputs must come from the actual created bucket and role."
  }
}
run "disabled_creates_nothing" {
  command = plan
  variables {
    site_frontend_bucket = ""
    site_docs_bucket     = ""
  }
  assert {
    condition     = length(aws_s3_bucket.private_evidence) == 0 && length(aws_iam_role.sandbox_terraform) == 0 && length(data.aws_kms_key.existing) == 0
    error_message = "Default bootstrap must have no managed effects or key lookup."
  }
  assert {
    condition     = output.bucket_name == null && output.terraform_role_arn == null
    error_message = "Disabled bootstrap identity outputs must be null."
  }
}
run "role_requires_store" {
  command = plan
  variables { enable_sandbox_terraform_role = true }
  expect_failures = [var.enable_sandbox_terraform_role]
}
run "rejects_wrong_environment" {
  command = plan
  variables {
    enable_private_evidence_store = true
    environment                   = "prod"
  }
  expect_failures = [var.enable_private_evidence_store]
}
run "rejects_wrong_region" {
  command = plan
  variables {
    enable_private_evidence_store = true
    aws_region                    = "us-west-2"
  }
  expect_failures = [var.enable_private_evidence_store]
}

run "capture_controls" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.private_evidence[0].versioning_configuration).status == "Enabled" && one(aws_s3_bucket_ownership_controls.private_evidence[0].rule).object_ownership == "BucketOwnerEnforced" && one(aws_s3_bucket_server_side_encryption_configuration.private_evidence[0].rule).bucket_key_enabled == false
    error_message = "Private capture needs versioning, owner enforcement and object-context KMS."
  }
  assert {
    condition     = contains(one([for s in jsondecode(output.bucket_policy).Statement : s if s.Sid == "ReviewerCannotWrite"]).NotAction, "s3:ListBucketVersions") && length([for s in jsondecode(output.bucket_policy).Statement : s if s.Sid == "ReviewerNamespaceListOnly"]) == 1
    error_message = "The existing private reader must list versions only within the Sandbox namespace."
  }
}
run "metadata_and_apply_permissions" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  assert {
    condition     = length(one([for s in jsondecode(output.terraform_role_policy).Statement : s if s.Sid == "TableMetadata"]).Resource) == 30 && one([for s in jsondecode(output.terraform_role_policy).Statement : s if s.Sid == "HistoryDeliveryIndex"]).Resource == "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable"
    error_message = "Grant the exact 30-table closure and only the history table mutation."
  }
  assert {
    condition     = alltrue([for action in flatten([for s in jsondecode(output.terraform_role_policy).Statement : s.Action]) : !contains(["iam:DeletePolicyVersion", "iam:PassRole", "iam:DetachRolePolicy", "iam:DeletePolicy", "iam:UntagPolicy", "iam:UpdateAssumeRolePolicy", "kms:PutKeyPolicy", "s3:DeleteObject", "dynamodb:Scan", "dynamodb:Query"], action) && !strcontains(action, "*")])
    error_message = "The base execution role cannot gain admin, pruning, content or broad read grants."
  }
}
run "rejects_wrong_identity" {
  command = plan
  variables { enable_private_evidence_store = true }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "999999999999" }
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}
run "rejects_disabled_key" {
  command = plan
  variables { enable_private_evidence_store = true }
  override_data {
    target = data.aws_kms_key.existing
    values = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", key_state = "Disabled" }
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}
run "rejects_foreign_oidc_provider" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  override_data {
    target = data.aws_iam_openid_connect_provider.github
    values = { arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com", client_id_list = ["sts.amazonaws.com"] }
  }
  expect_failures = [aws_iam_role.sandbox_terraform]
}
run "rejects_wildcard_ref" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
    trusted_refs                  = ["refs/heads/*"]
  }
  expect_failures = [var.trusted_refs]
}
run "rejects_executor_as_administrator" {
  command = plan
  variables {
    enable_private_evidence_store = true
    administrator_role_arn        = "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-terraform"
  }
  expect_failures = [aws_s3_bucket.private_evidence]
}

run "rejects_wildcard_administrator" {
  command = plan
  variables {
    enable_private_evidence_store = true
    administrator_role_arn        = "arn:aws:iam::123456789012:role/*"
  }
  expect_failures = [var.administrator_role_arn]
}

run "site_permissions_exact_grants" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
  assert {
    condition     = length(local.terraform_role_policy) <= 10240 && one([for s in jsondecode(local.terraform_role_policy).Statement : s if s.Sid == "SitePolicy"]).Resource == "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-site-publishing"
    error_message = "The site policy must be exact and the complete inline policy must fit IAM."
  }
  assert {
    condition     = one([for s in jsondecode(local.terraform_role_policy).Statement : s if s.Sid == "SiteAttachment"]).Resource == "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy" && one([for s in jsondecode(local.terraform_role_policy).Statement : s if s.Sid == "SiteAttachment"]).Condition.StringEquals["iam:PolicyARN"] == "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-site-publishing"
    error_message = "Attachment authority must bind both the exact deployment role and policy."
  }
}

run "rejects_empty_frontend_bucket" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
    site_frontend_bucket          = ""
  }
  expect_failures = [var.site_frontend_bucket]
}

run "rejects_wildcard_frontend_bucket" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
    site_frontend_bucket          = "*"
  }
  expect_failures = [var.site_frontend_bucket]
}

run "rejects_empty_docs_bucket" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
    site_docs_bucket              = ""
  }
  expect_failures = [var.site_docs_bucket]
}

run "rejects_wildcard_docs_bucket" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
    site_docs_bucket              = "*"
  }
  expect_failures = [var.site_docs_bucket]
}
