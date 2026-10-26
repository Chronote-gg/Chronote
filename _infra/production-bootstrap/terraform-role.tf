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
      { Sid = "TableMetadata", Effect = "Allow", Action = ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource"], Resource = [local.control_table_arn, "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-prod-ActiveMeetingTable", "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-prod-MeetingHistoryTable"] },
      { Sid = "KeyMetadata", Effect = "Allow", Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"], Resource = var.kms_key_arn },
      { Sid = "ControlEncryption", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = "meeting-notes-prod-DeploymentControlTable", "kms:EncryptionContext:aws:dynamodb:subscriberId" = var.production_account_id } } },
      # DynamoDB requests its table-constrained grants on behalf of the creator.
      { Sid = "ControlServiceGrant", Effect = "Allow", Action = "kms:CreateGrant", Resource = var.kms_key_arn, Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" }, StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id, "kms:GrantConstraintType" = "EncryptionContextSubset", "kms:RetiringPrincipal" = "dynamodb.us-east-1.amazonaws.com", "kms:GranteePrincipal" = "dynamodb.us-east-1.amazonaws.com", "kms:EncryptionContext:aws:dynamodb:tableName" = "meeting-notes-prod-DeploymentControlTable", "kms:EncryptionContext:aws:dynamodb:subscriberId" = var.production_account_id }, "ForAllValues:StringEquals" = { "kms:GrantOperations" = ["Decrypt", "Encrypt", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "ReEncryptFrom", "ReEncryptTo", "RetireGrant", "DescribeKey"] } } },
      # ELB offers no VPC condition for CreateTargetGroup; the saved-plan guard binds it.
      { Sid = "SpareTargetGroup", Effect = "Allow", Action = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"], Resource = "arn:aws:elasticloadbalancing:us-east-1:${var.production_account_id}:targetgroup/meeting-notes-prod-api-spare/*" },
      # IAM cannot constrain PutRolePolicy's submitted name or body. Trusted source must.
      { Sid = "RuntimeInlinePolicy", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"], Resource = local.app_role_arn },
      { Sid = "RoutingPolicy", Effect = "Allow", Action = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"], Resource = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-deployment-routing" },
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
