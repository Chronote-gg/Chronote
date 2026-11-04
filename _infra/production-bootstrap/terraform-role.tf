resource "aws_iam_role" "production_terraform" {
  count                = var.enable_production_terraform_role ? 1 : 0
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
        "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:environment:production"
        "token.actions.githubusercontent.com:repository_id"       = var.github_repository_id
        "token.actions.githubusercontent.com:repository_owner_id" = var.github_owner_id
        "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
      } }
    }]
  })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_iam_openid_connect_provider.github[0].arn == "arn:aws:iam::${var.production_account_id}:oidc-provider/token.actions.githubusercontent.com"
      error_message = "GitHub provider must belong to the reviewed production account."
    }
  }
}
locals {
  deploy_role_arn     = "arn:aws:iam::${var.production_account_id}:role/meeting-notes-prod-github-deploy"
  site_policy_arn     = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-site-publishing"
  dynamodb_policy_arn = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-bot-dynamodb-policy"
  routing_policy_arn  = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-deployment-routing"
}
resource "aws_iam_role_policy" "production_terraform" {
  count      = var.enable_production_terraform_role ? 1 : 0
  name       = "meeting-notes-prod-terraform-prerequisites"
  role       = local.terraform_role_name
  depends_on = [aws_iam_role.production_terraform]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ApplicationState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "arn:aws:s3:::${local.state_bucket}/${local.state_key}" },
      # Terraform 1.16 Workspaces lists workspace_key_prefix plus '/', even for default.
      { Sid = "DefaultWorkspaceDiscovery", Effect = "Allow", Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.state_bucket}", Condition = { StringEquals = { "s3:prefix" = "meeting-notes-terraform/" } } },
      { Sid = "StateLockMetadata", Effect = "Allow", Action = "dynamodb:DescribeTable", Resource = "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-terraform-state-locks" },
      { Sid = "ProductionStateLocks", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-terraform-state-locks", Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["${local.state_bucket}/${local.state_key}", "${local.state_bucket}/${local.state_key}-md5"] } } },
      { Sid = "ControlTable", Effect = "Allow", Action = ["dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive", "dynamodb:UpdateContinuousBackups", "dynamodb:TagResource", "dynamodb:UntagResource"], Resource = local.control_table_arn },
      { Sid = "ControlGuard", Effect = "Allow", Action = "dynamodb:GetItem", Resource = local.control_table_arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["ENV"] } } },
      { Sid = "TableMetadata", Effect = "Allow", Action = ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource"], Resource = "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-prod-*" },
      { Sid = "RenewalIndex", Effect = "Allow", Action = "dynamodb:UpdateTable", Resource = "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-prod-GuildSubscriptionTable" },
      { Sid = "KeyMetadata", Effect = "Allow", Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"], Resource = var.kms_key_arn },
      { Sid = "ControlEncryption", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = ["meeting-notes-prod-DeploymentControlTable", "meeting-notes-prod-GuildSubscriptionTable"], "kms:EncryptionContext:aws:dynamodb:subscriberId" = var.production_account_id } } },
      # DynamoDB requests grants on behalf of the creator. Grantee/retiring keys take principal ARNs, not service
      # principals, so table creation stays bound by the exact CreateTable ARN instead.
      { Sid = "ControlServiceGrant", Effect = "Allow", Action = "kms:CreateGrant", Resource = var.kms_key_arn, Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" }, StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id, "kms:GrantConstraintType" = "EncryptionContextSubset" }, "ForAllValues:StringEquals" = { "kms:GrantOperations" = ["Decrypt", "Encrypt", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "ReEncryptFrom", "ReEncryptTo", "RetireGrant", "DescribeKey"] } } },
      # ELB offers no VPC condition for CreateTargetGroup; the saved-plan guard binds it.
      { Sid = "SpareTargetGroup", Effect = "Allow", Action = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"], Resource = "arn:aws:elasticloadbalancing:us-east-1:${var.production_account_id}:targetgroup/meeting-notes-prod-api-spare/*" },
      # The runtime plan validator lets only the API target groups' drain delay change.
      { Sid = "ApiDrainDelay", Effect = "Allow", Action = "elasticloadbalancing:ModifyTargetGroupAttributes", Resource = [for name in ["api-tg", "api-spare"] : "arn:aws:elasticloadbalancing:us-east-1:${var.production_account_id}:targetgroup/meeting-notes-prod-${name}/*"] },
      # IAM cannot constrain PutRolePolicy's submitted name or body. Trusted source must.
      { Sid = "RuntimeInlinePolicy", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"], Resource = local.app_role_arn },
      { Sid = "ManagedPolicies", Effect = "Allow", Action = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"], Resource = [local.routing_policy_arn, local.site_policy_arn, local.dynamodb_policy_arn] },
      # The provider prunes the oldest non-default version when the task-role policy already has five.
      { Sid = "TaskPolicyVersionPrune", Effect = "Allow", Action = "iam:DeletePolicyVersion", Resource = local.dynamodb_policy_arn },
      # IAM cannot constrain trust or inline documents; the runtime plan validator and protected source must.
      { Sid = "RuntimeRoles", Effect = "Allow", Action = ["iam:CreateRole", "iam:TagRole", "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"], Resource = [local.deploy_role_arn, "arn:aws:iam::${var.production_account_id}:role/meeting-notes-prod-prompt-guard"] },
      { Sid = "DeployRoleAttachments", Effect = "Allow", Action = "iam:AttachRolePolicy", Resource = local.deploy_role_arn, Condition = { ArnEquals = { "iam:PolicyARN" = [local.routing_policy_arn, local.site_policy_arn] } } },
      { Sid = "GitHubProviderMetadata", Effect = "Allow", Action = "iam:GetOpenIDConnectProvider", Resource = "arn:aws:iam::${var.production_account_id}:oidc-provider/token.actions.githubusercontent.com" },
      { Sid = "SecretMetadata", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"], Resource = "arn:aws:secretsmanager:us-east-1:${var.production_account_id}:secret:meeting-notes-prod/*" },
      { Sid = "SiteBucketMetadata", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging"], Resource = [for site in ["frontend", "docs"] : "arn:aws:s3:::meeting-notes-prod-${site}-${var.production_account_id}"] },
      # Site certificate, distribution, origin access control and headers policy IDs are generated; function names are not.
      { Sid = "SiteCertificateMetadata", Effect = "Allow", Action = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"], Resource = "arn:aws:acm:us-east-1:${var.production_account_id}:certificate/*" },
      { Sid = "SiteCdnMetadata", Effect = "Allow", Action = ["cloudfront:GetDistribution", "cloudfront:GetOriginAccessControl", "cloudfront:GetResponseHeadersPolicy", "cloudfront:DescribeFunction", "cloudfront:GetFunction", "cloudfront:ListTagsForResource"], Resource = concat([for type in ["distribution", "origin-access-control", "response-headers-policy"] : "arn:aws:cloudfront::${var.production_account_id}:${type}/*"], [for name in ["frontend-route-rewrite", "docs-index-rewrite"] : "arn:aws:cloudfront::${var.production_account_id}:function/meeting-notes-prod-${name}"]) },
      { Sid = "ClusterMetadata", Effect = "Allow", Action = ["ecs:DescribeClusters", "ecs:ListTagsForResource"], Resource = "arn:aws:ecs:us-east-1:${var.production_account_id}:cluster/meeting-notes-prod-bot-cluster" },
      { Sid = "CertificateMetadata", Effect = "Allow", Action = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"], Resource = var.production_certificate_arn },
      { Sid = "ZoneMetadata", Effect = "Allow", Action = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource"], Resource = "arn:aws:route53:::hostedzone/${var.production_hosted_zone_id}" },
      { Sid = "ZoneDiscovery", Effect = "Allow", Action = "route53:ListHostedZones", Resource = "*" },
      { Sid = "RegionalMetadata", Effect = "Allow", Action = ["ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeCapacityReservation", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeListenerCertificates", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTags"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } },
      { Sid = "EvidenceControlReadback", Effect = "Allow", Action = local.capture_reads, Resource = local.bucket_arn },
      { Sid = "EvidenceConditionalCreate", Effect = "Allow", Action = "s3:PutObject", Resource = local.capture_objects, Condition = { StringEquals = { "s3:if-none-match" = "*", "s3:x-amz-server-side-encryption" = "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id" = var.kms_key_arn } } },
      { Sid = "EvidenceVersionReadback", Effect = "Allow", Action = "s3:GetObjectVersion", Resource = local.capture_objects },
      { Sid = "EvidenceEncryption", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "s3.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = local.capture_objects } } }
    ]
  })
  lifecycle { prevent_destroy = true }
}
