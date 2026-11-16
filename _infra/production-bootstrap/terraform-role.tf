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
        # Only these two workflows; deploy jobs in the same environment cannot.
        "token.actions.githubusercontent.com:workflow" = ["Terraform Apply", "Terraform Plan"]
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
  region_account = "us-east-1:${var.production_account_id}"
  iam_arn        = "arn:aws:iam::${var.production_account_id}"
  # The role held by an approved Apply is close to account administrator; the
  # controls are the workflow-pinned OIDC trust, the master ref and the owner's
  # approval. Names, tags and the inline denies only limit accidents.
  named_resources = [
    "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-prod-*",
    "arn:aws:s3:::meeting-notes-prod-*",
    "arn:aws:logs:${local.region_account}:log-group:/ecs/meeting-notes-prod-*",
    "arn:aws:logs:${local.region_account}:log-group:/aws/lambda/meeting-notes-prod-*",
    "arn:aws:logs:${local.region_account}:log-group:/vpc/flow/app-vpc*",
    "arn:aws:cloudwatch:${local.region_account}:alarm:meeting-notes-prod-*",
    "arn:aws:sns:${local.region_account}:meeting-notes-prod-*",
    "arn:aws:lambda:${local.region_account}:function:meeting-notes-prod-*",
    "arn:aws:events:${local.region_account}:rule/meeting-notes-prod-*",
    "arn:aws:ecr:${local.region_account}:repository/meeting-notes-prod-*",
    "arn:aws:ecs:${local.region_account}:*/meeting-notes-prod-*",
    "arn:aws:elasticloadbalancing:${local.region_account}:*/meeting-notes-prod-*",
    "arn:aws:secretsmanager:${local.region_account}:secret:meeting-notes-prod/*",
  ]
  # The flow log role keeps its legacy unprefixed name in production.
  iam_roles = ["${local.iam_arn}:role/meeting-notes-prod-*", "${local.iam_arn}:role/vpc_flow_logs_role"]
  # Application policies plus the only AWS managed policies _infra attaches.
  attachable_policies = [
    "${local.iam_arn}:policy/meeting-notes-prod-*",
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    "arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess",
    "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess",
  ]
  generated_id_actions = [
    "ec2:*Vpc*", "ec2:*Subnet*", "ec2:*InternetGateway*", "ec2:*Route*", "ec2:*SecurityGroup*", "ec2:*FlowLogs", "ec2:CreateTags", "ec2:DeleteTags",
    "cloudfront:*", "acm:*", "appconfig:*", "aps:*", "grafana:*", "elasticache:*",
    "ce:*CostCategoryDefinition", "ce:TagResource", "ce:UntagResource",
    "route53:ChangeResourceRecordSets", "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "kms:CreateKey",
  ]
  # The application key carries the provider's default Environment tag.
  key_actions = [
    "kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource",
    "kms:CreateGrant", "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*",
  ]
  iam_write_actions = [
    "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
    "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PassRole",
    "iam:CreatePolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
  ]
  state_lock_keys = ["${local.state_bucket}/${local.state_key}", "${local.state_bucket}/${local.state_key}-md5"]
  delivery_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "NamedResources", Effect = "Allow", Action = ["dynamodb:*", "s3:*", "logs:*", "cloudwatch:*", "sns:*", "lambda:*", "events:*", "ecr:*", "ecs:*", "elasticloadbalancing:*", "secretsmanager:*"], Resource = local.named_resources },
      # These ARNs carry generated IDs, not names. Sandbox resources of these
      # types are protected by the inline SandboxResources deny instead.
      { Sid = "GeneratedIdResources", Effect = "Allow", Action = local.generated_id_actions, Resource = "*" },
      { Sid = "ProductionKeys", Effect = "Allow", Action = local.key_actions, Resource = "arn:aws:kms:${local.region_account}:key/*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "prod" } } },
      { Sid = "IamWrites", Effect = "Allow", Action = local.iam_write_actions, Resource = concat(local.iam_roles, ["${local.iam_arn}:policy/meeting-notes-prod-*"]) },
      { Sid = "IamAttachments", Effect = "Allow", Action = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], Resource = local.iam_roles, Condition = { ArnLike = { "iam:PolicyARN" = local.attachable_policies } } },
      { Sid = "ApplicationState", Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${local.state_bucket}/${local.state_key}" },
      { Sid = "ApplicationStateLocks", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-terraform-state-locks", Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = local.state_lock_keys } } }
    ]
  })
}
# A full plan reads every resource type in _infra, so reads come from AWS's
# own read-only policy rather than a hand-kept list.
resource "aws_iam_role_policy_attachment" "production_terraform_read_only" {
  count      = var.enable_production_terraform_role ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
  depends_on = [aws_iam_role.production_terraform]
}
resource "aws_iam_policy" "production_terraform_delivery" {
  count  = var.enable_production_terraform_role ? 1 : 0
  name   = "meeting-notes-prod-terraform-delivery"
  policy = local.delivery_policy
}
resource "aws_iam_role_policy_attachment" "production_terraform_delivery" {
  count      = var.enable_production_terraform_role ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.production_terraform_delivery[0].arn
  depends_on = [aws_iam_role.production_terraform]
}
# The guardrails live in the role's existing inline policy. Every grant above
# is limited by these denies, and OwnIdentity keeps the role from editing them.
resource "aws_iam_role_policy" "production_terraform" {
  count      = var.enable_production_terraform_role ? 1 : 0
  name       = "meeting-notes-prod-terraform-prerequisites"
  role       = local.terraform_role_name
  depends_on = [aws_iam_role.production_terraform]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "OwnIdentity", Effect = "Deny", NotAction = ["iam:Get*", "iam:List*"], Resource = [local.terraform_role_arn, "${local.iam_arn}:policy/meeting-notes-prod-terraform*", "${local.iam_arn}:oidc-provider/*"] },
      { Sid = "RolesOutsideApplication", Effect = "Deny", Action = ["iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PassRole"], NotResource = local.iam_roles },
      { Sid = "PrivilegedPolicies", Effect = "Deny", Action = ["iam:AttachRolePolicy", "iam:AttachUserPolicy", "iam:AttachGroupPolicy"], Resource = "*", Condition = { ArnEquals = { "iam:PolicyARN" = ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/IAMFullAccess", "arn:aws:iam::aws:policy/PowerUserAccess"] } } },
      { Sid = "BootstrapState", Effect = "Deny", Action = ["s3:PutObject", "s3:DeleteObject*"], Resource = "arn:aws:s3:::${local.state_bucket}/meeting-notes-terraform/*-bootstrap/*" },
      # ReadOnlyAccess would otherwise read meeting data, which Terraform never needs.
      { Sid = "CustomerData", Effect = "Deny", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PartiQLSelect", "dynamodb:Export*", "s3:GetObject*"], Resource = ["arn:aws:dynamodb:${local.region_account}:table/meeting-notes-prod-*", "arn:aws:s3:::meeting-notes-prod-*/*"] },
      { Sid = "SandboxResources", Effect = "Deny", Action = "*", Resource = "*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "sandbox" } } }
    ]
  })
  lifecycle { prevent_destroy = true }
}
