resource "aws_iam_role" "sandbox_terraform" {
  count                = var.enable_sandbox_terraform_role ? 1 : 0
  name                 = local.terraform_role_name
  path                 = "/"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github[0].arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:environment:sandbox"
        "token.actions.githubusercontent.com:repository_id"       = var.github_repository_id
        "token.actions.githubusercontent.com:repository_owner_id" = var.github_owner_id
        "token.actions.githubusercontent.com:ref"                 = sort(tolist(var.trusted_refs))
      } }
    }]
  })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_iam_openid_connect_provider.github[0].arn == "arn:aws:iam::${var.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com" && contains(data.aws_iam_openid_connect_provider.github[0].client_id_list, "sts.amazonaws.com")
      error_message = "GitHub provider must belong to the reviewed sandbox account."
    }
  }
}

locals {
  terraform_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "SitePolicy", Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:CreatePolicy", "iam:TagPolicy", "iam:CreatePolicyVersion"], Resource = "arn:aws:iam::${var.sandbox_account_id}:policy/meeting-notes-sandbox-site-publishing" },
      { Sid = "SiteAttachment", Effect = "Allow", Action = "iam:AttachRolePolicy", Resource = "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-github-deploy", Condition = { StringEquals = { "iam:PolicyARN" = "arn:aws:iam::${var.sandbox_account_id}:policy/meeting-notes-sandbox-site-publishing" } } },
      { Sid = "SiteRoleMetadata", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"], Resource = "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-github-deploy" },
      { Sid = "SiteBucketMetadata", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging"], Resource = ["arn:aws:s3:::${var.site_frontend_bucket}", "arn:aws:s3:::${var.site_docs_bucket}"] },
      { Sid = "SiteOidcMetadata", Effect = "Allow", Action = ["iam:GetOpenIDConnectProvider"], Resource = "arn:aws:iam::${var.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com" },
      { Sid = "ApplicationState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "arn:aws:s3:::${local.state_bucket}/${local.state_key}" },
      # Terraform 1.16 workspace discovery lists this prefix, including when TF_WORKSPACE is set.
      { Sid = "WorkspaceDiscovery", Effect = "Allow", Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.state_bucket}", Condition = { StringEquals = { "s3:prefix" = ["meeting-notes-terraform/", "meeting-notes-terraform/sandbox/"] } } },
      { Sid = "StateLockMetadata", Effect = "Allow", Action = "dynamodb:DescribeTable", Resource = "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-terraform-state-locks" },
      { Sid = "SandboxStateLocks", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-terraform-state-locks", Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["${local.state_bucket}/${local.state_key}", "${local.state_bucket}/${local.state_key}-md5"] } } },
      { Sid = "TableMetadata", Effect = "Allow", Action = ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource"], Resource = local.table_arns },
      { Sid = "RuntimePolicyMetadata", Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"], Resource = local.runtime_policy_arn },
      { Sid = "KeyMetadata", Effect = "Allow", Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"], Resource = var.kms_key_arn },
      { Sid = "HistoryDeliveryIndex", Effect = "Allow", Action = "dynamodb:UpdateTable", Resource = "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-sandbox-MeetingHistoryTable" },
      { Sid = "RuntimePolicyVersion", Effect = "Allow", Action = ["iam:ListPolicyVersions", "iam:CreatePolicyVersion"], Resource = local.runtime_policy_arn },
      { Sid = "CaptureControls", Effect = "Allow", Action = local.capture_reads, Resource = local.bucket_arn },
      { Sid = "ConditionalCapture", Effect = "Allow", Action = "s3:PutObject", Resource = local.capture_objects, Condition = { StringEquals = { "s3:if-none-match" = "*", "s3:x-amz-server-side-encryption" = "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id" = var.kms_key_arn } } },
      { Sid = "ExactVersionCapture", Effect = "Allow", Action = "s3:GetObjectVersion", Resource = local.capture_objects },
      { Sid = "CaptureKeyUse", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "s3.us-east-1.amazonaws.com", "kms:CallerAccount" = var.sandbox_account_id }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = local.capture_objects } } }
    ]
  })
}
resource "aws_iam_role_policy" "sandbox_terraform" {
  count      = var.enable_sandbox_terraform_role ? 1 : 0
  name       = "meeting-notes-sandbox-terraform-prerequisites"
  role       = local.terraform_role_name
  depends_on = [aws_iam_role.sandbox_terraform]
  policy     = local.terraform_role_policy
  lifecycle { prevent_destroy = true }
}
