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
  production_account_id      = "123456789012"
  kms_key_arn                = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111"
  administrator_role_arn     = "arn:aws:iam::123456789012:role/Administrator"
  reviewer_role_arn          = "arn:aws:iam::123456789012:role/Administrator"
  github_repository_id       = "123456"
  github_owner_id            = "654321"
  production_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  production_hosted_zone_id  = "Z0123456789"
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
    condition     = length(aws_s3_bucket.private_evidence) + length(aws_s3_bucket_public_access_block.private_evidence) + length(aws_s3_bucket_ownership_controls.private_evidence) + length(aws_s3_bucket_versioning.private_evidence) + length(aws_s3_bucket_server_side_encryption_configuration.private_evidence) + length(aws_s3_bucket_policy.private_evidence) + length(aws_iam_role.production_terraform) + length(aws_iam_role_policy.production_terraform) == 8
    error_message = "Bootstrap must own exactly six bucket controls and two IAM resources."
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
    condition     = jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Chronote-gg/Chronote:environment:production" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/master" && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_id"] == var.github_repository_id && jsondecode(aws_iam_role.production_terraform[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_owner_id"] == var.github_owner_id && aws_iam_role.production_terraform[0].max_session_duration == 3600
    error_message = "Trust must bind production, master and both immutable IDs for one hour."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : alltrue([for a in flatten([s.Action]) : !contains(["iam:PassRole", "iam:UpdateAssumeRolePolicy", "ecs:UpdateService", "ecs:RegisterTaskDefinition", "elasticloadbalancing:ModifyListener", "secretsmanager:GetSecretValue", "dynamodb:Scan", "dynamodb:Query", "s3:DeleteObject", "kms:PutKeyPolicy"], a)])])
    error_message = "Terraform may prepare the deployment prerequisites and runtime, never exercise deployment/customer or self-administration authority."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s.Sid == "DeployRoleAttachments" if contains(flatten([s.Action]), "iam:AttachRolePolicy")]) && one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "DeployRoleAttachments"]) == { Sid = "DeployRoleAttachments", Effect = "Allow", Action = "iam:AttachRolePolicy", Resource = "arn:aws:iam::123456789012:role/meeting-notes-prod-github-deploy", Condition = { ArnEquals = { "iam:PolicyARN" = ["arn:aws:iam::123456789012:policy/meeting-notes-prod-deployment-routing", "arn:aws:iam::123456789012:policy/meeting-notes-prod-site-publishing"] } } }
    error_message = "Attachment authority must bind the deploy role to the routing and site publishing policies only."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s.Resource == "arn:aws:iam::123456789012:policy/meeting-notes-prod-bot-dynamodb-policy" if contains(flatten([s.Action]), "iam:DeletePolicyVersion")])
    error_message = "Only the task-role DynamoDB policy may have old versions pruned."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : toset(flatten([s.Resource])) == toset(["arn:aws:iam::123456789012:role/meeting-notes-prod-github-deploy", "arn:aws:iam::123456789012:role/meeting-notes-prod-prompt-guard"]) if contains(flatten([s.Action]), "iam:CreateRole")]) && one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s.Resource if contains(flatten([s.Action]), "dynamodb:UpdateTable") && s.Sid != "ControlTable"]) == "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-prod-GuildSubscriptionTable"
    error_message = "Runtime writes must bind the two named roles and the subscription table index change."
  }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s.Resource if contains(flatten([s.Action]), "elasticloadbalancing:ModifyTargetGroupAttributes")])) == toset(["arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/meeting-notes-prod-api-spare/*", "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/meeting-notes-prod-api-tg/*"])
    error_message = "Target group attribute writes must bind the spare and serving API target groups only."
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
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "TableMetadata"]).Resource == "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-prod-*"
    error_message = "The runtime graph refreshes every application table, read metadata only and never the state lock table."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : alltrue([for a in flatten([s.Action]) : !strcontains(a, "*")])])
    error_message = "Use exact API operations, never action wildcards."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : alltrue([for a in flatten([s.Action]) : startswith(a, "ec2:Describe") || startswith(a, "elasticloadbalancing:Describe") || a == "route53:ListHostedZones"]) if try(s.Resource == "*", false)])
    error_message = "Wildcard resources must contain only unavoidable metadata reads."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "ApplicationState"]).Resource == "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/state" && one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "ProductionStateLocks"]).Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] == ["meeting-notes-terraform-state-bucket/meeting-notes-terraform/state", "meeting-notes-terraform-state-bucket/meeting-notes-terraform/state-md5"]
    error_message = "State and lock access must exclude bootstrap and Sandbox keys."
  }
  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ConditionalCreateOnly"]).Condition.StringNotEquals["s3:if-none-match"] == "*" && one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ExactKMSKey"]).Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"] == var.kms_key_arn && one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ExactVersionReview"]).Resource == "arn:aws:s3:::meeting-notes-prod-private-evidence-123456789012/terraform/production/*"
    error_message = "Capture requires conditional creates, exact key and exact-version access in the first namespace only."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "EvidenceEncryption"]).Condition.StringEquals["kms:ViaService"] == "s3.us-east-1.amazonaws.com" && one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "ControlServiceGrant"]).Condition.Bool["kms:GrantIsForAWSResource"] == "true" && one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "ControlEncryption"]).Condition.StringEquals["kms:EncryptionContext:aws:dynamodb:tableName"] == ["meeting-notes-prod-DeploymentControlTable", "meeting-notes-prod-GuildSubscriptionTable"]
    error_message = "S3 and DynamoDB KMS paths need distinct service/account/context restrictions."
  }
  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.private_evidence[0].policy).Statement : s if s.Sid == "ReviewerCannotWrite"]).Condition.ArnNotEquals["aws:PrincipalArn"] == var.administrator_role_arn
    error_message = "The explicitly selected administrator may perform human review without losing maintenance authority."
  }
}
run "grant_uses_supported_service_keys" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_terraform[0].policy).Statement : s if s.Sid == "ControlServiceGrant"]).Condition == { Bool = { "kms:GrantIsForAWSResource" = "true" }, StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = "123456789012", "kms:GrantConstraintType" = "EncryptionContextSubset" }, "ForAllValues:StringEquals" = { "kms:GrantOperations" = ["Decrypt", "Encrypt", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "ReEncryptFrom", "ReEncryptTo", "RetireGrant", "DescribeKey"] } }
    error_message = "DynamoDB service grants keep service mediation and bounded operations, without principal-ARN or table-context keys a service-made grant cannot satisfy."
  }
}
run "site_delivery_off_by_default" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
  }
  assert {
    condition     = length(aws_iam_policy.site_delivery) == 0 && length(aws_iam_role_policy_attachment.site_delivery) == 0
    error_message = "The initial bootstrap creates no site delivery policy."
  }
}
run "site_delivery_requires_role" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_site_delivery_policy   = true
    frontend_distribution_id      = "EFRONTEND1"
    docs_distribution_id          = "EDOCS2"
  }
  expect_failures = [var.enable_site_delivery_policy]
}
run "site_delivery_requires_distribution_ids" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
    enable_site_delivery_policy      = true
    docs_distribution_id             = "arn:aws:cloudfront::123456789012:distribution/EDOCS2"
  }
  expect_failures = [var.frontend_distribution_id, var.docs_distribution_id]
}
run "site_delivery_policy" {
  command = plan
  variables {
    enable_private_evidence_store    = true
    enable_production_terraform_role = true
    enable_site_delivery_policy      = true
    frontend_distribution_id         = "EFRONTEND1"
    docs_distribution_id             = "EDOCS2"
  }
  assert {
    condition = jsondecode(aws_iam_policy.site_delivery[0].policy).Statement == [
      { Sid = "ExistingDistributions", Effect = "Allow", Action = "cloudfront:UpdateDistribution", Resource = ["arn:aws:cloudfront::123456789012:distribution/EFRONTEND1", "arn:aws:cloudfront::123456789012:distribution/EDOCS2"] },
      { Sid = "RouteRewriteFunction", Effect = "Allow", Action = ["cloudfront:CreateFunction", "cloudfront:PublishFunction", "cloudfront:TagResource"], Resource = "arn:aws:cloudfront::123456789012:function/meeting-notes-prod-frontend-route-rewrite" },
      { Sid = "CrawlerHeadersPolicy", Effect = "Allow", Action = "cloudfront:CreateResponseHeadersPolicy", Resource = "arn:aws:cloudfront::123456789012:response-headers-policy/*" }
    ]
    error_message = "Site delivery may update only the two distributions and create only the route function and headers policy."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.site_delivery[0].role == "meeting-notes-prod-github-terraform" && aws_iam_policy.site_delivery[0].name == "meeting-notes-prod-terraform-site-delivery"
    error_message = "The managed policy attaches to the production Terraform role."
  }
}
