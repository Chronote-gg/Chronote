variable "enable_sandbox_terraform_delivery" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_sandbox_terraform_delivery || var.enable_sandbox_terraform_role
    error_message = "Delivery migration requires the existing Sandbox Terraform role."
  }
}

locals {
  delivery_apply_trust = var.enable_sandbox_terraform_role ? jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github[0].arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:environment:sandbox"
        "token.actions.githubusercontent.com:repository_id"       = var.github_repository_id
        "token.actions.githubusercontent.com:repository_owner_id" = var.github_owner_id
        "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
        "token.actions.githubusercontent.com:workflow"            = "Terraform Apply"
      } }
    }]
  }) : null
  terraform_role_policy = var.enable_sandbox_terraform_delivery ? local.delivery_guardrails : local.legacy_terraform_role_policy
}

locals {
  region_account = "us-east-1:${var.sandbox_account_id}"
  iam_arn        = "arn:aws:iam::${var.sandbox_account_id}"
  # The role held by an approved Apply is close to account administrator; the
  # controls are the workflow-pinned OIDC trust, the master ref and the owner's
  # approval. Names, tags and the inline denies only limit accidents.
  named_resources = [
    "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-sandbox-*",
    "arn:aws:s3:::meeting-notes-sandbox-*",
    "arn:aws:logs:${local.region_account}:log-group:/ecs/meeting-notes-sandbox-*",
    "arn:aws:logs:${local.region_account}:log-group:/aws/lambda/meeting-notes-sandbox-*",
    "arn:aws:logs:${local.region_account}:log-group:/vpc/flow/meeting-notes-sandbox*",
    "arn:aws:cloudwatch:${local.region_account}:alarm:meeting-notes-sandbox-*",
    "arn:aws:sns:${local.region_account}:meeting-notes-sandbox-*",
    "arn:aws:lambda:${local.region_account}:function:meeting-notes-sandbox-*",
    "arn:aws:events:${local.region_account}:rule/meeting-notes-sandbox-*",
    "arn:aws:ecr:${local.region_account}:repository/meeting-notes-sandbox-*",
    "arn:aws:ecs:${local.region_account}:*/meeting-notes-sandbox-*",
    "arn:aws:elasticloadbalancing:${local.region_account}:*/meeting-notes-sandbox-*",
    "arn:aws:secretsmanager:${local.region_account}:secret:meeting-notes-sandbox/*",
    "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-*",
    "arn:aws:sqs:${local.region_account}:meeting-notes-sandbox-*",
  ]
  production_named_resources = concat([for arn in local.named_resources : replace(arn, "meeting-notes-sandbox", "meeting-notes-prod")], ["${local.iam_arn}:role/meeting-notes-prod-*", "${local.iam_arn}:policy/meeting-notes-prod-*", "${local.iam_arn}:role/vpc_flow_logs_role", "arn:aws:logs:${local.region_account}:log-group:/vpc/flow/app-vpc*"])
  iam_roles                  = ["${local.iam_arn}:role/meeting-notes-sandbox-*"]
  # Application policies plus the only AWS managed policies _infra attaches.
  attachable_policies = [
    "${local.iam_arn}:policy/meeting-notes-sandbox-*",
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    "arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess",
    "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess",
  ]
  generated_id_actions = [
    "ec2:*Vpc*", "ec2:*Subnet*", "ec2:*InternetGateway*", "ec2:*Route*", "ec2:*SecurityGroup*", "ec2:*FlowLogs", "ec2:CreateTags", "ec2:DeleteTags",
    "cloudfront:*", "acm:*", "appconfig:*", "aps:*", "grafana:*", "elasticache:*",
    "ce:*CostCategoryDefinition", "ce:TagResource", "ce:UntagResource",
    "route53:ChangeResourceRecordSets", "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition",
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
  state_lock_keys           = ["${local.state_bucket}/${local.state_key}", "${local.state_bucket}/${local.state_key}-md5"]
  sandbox_search_bucket_arn = "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-search-${var.sandbox_account_id}"
  # Saved plans and Terraform logs (scripts/deployment/terraform-runs.cjs
  # planStore). If-None-Match makes every key write-once.
  plan_store_statement = { Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${local.state_bucket}/terraform-plans/sandbox/*", Condition = { StringEquals = { "s3:if-none-match" = "*" } } }
  delivery_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "NamedResources", Effect = "Allow", Action = ["dynamodb:*", "s3:*", "s3vectors:*", "sqs:*", "logs:*", "cloudwatch:*", "sns:*", "lambda:*", "events:*", "ecr:*", "ecs:*", "elasticloadbalancing:*", "secretsmanager:*"], Resource = local.named_resources },
      { Sid = "SearchProjectionMapping", Effect = "Allow", Action = ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping"], Resource = "arn:aws:lambda:${local.region_account}:event-source-mapping:*", Condition = { ArnEquals = { "lambda:FunctionArn" = "arn:aws:lambda:${local.region_account}:function:meeting-notes-sandbox-search-projection" } } },
      { Sid = "SearchMappingTags", Effect = "Allow", Action = "lambda:TagResource", Resource = "arn:aws:lambda:${local.region_account}:event-source-mapping:*", Condition = { StringEquals = { "aws:RequestTag/Environment" = "sandbox" }, StringEqualsIfExists = { "aws:ResourceTag/Environment" = "sandbox" } } },
      { Sid = "SearchMappingUntag", Effect = "Allow", Action = "lambda:UntagResource", Resource = "arn:aws:lambda:${local.region_account}:event-source-mapping:*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "sandbox" } } },
      # Generated IDs are bounded by the production tag deny below.
      { Sid = "GeneratedIdResources", Effect = "Allow", Action = local.generated_id_actions, Resource = "*" },
      # A new key exists only once created, so creation is bound by the tag the
      # request carries; every later key action by the tag the key has.
      { Sid = "SandboxKeyCreation", Effect = "Allow", Action = ["kms:CreateKey", "kms:TagResource"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Environment" = "sandbox" } } },
      { Sid = "SandboxKeys", Effect = "Allow", Action = local.key_actions, Resource = "arn:aws:kms:${local.region_account}:key/*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "sandbox" } } },
      { Sid = "IamWrites", Effect = "Allow", Action = local.iam_write_actions, Resource = concat(local.iam_roles, ["${local.iam_arn}:policy/meeting-notes-sandbox-*"]) },
      # Creating a resource of these services for the first time creates its
      # service-linked role.
      { Sid = "ServiceLinkedRoles", Effect = "Allow", Action = "iam:CreateServiceLinkedRole", Resource = "${local.iam_arn}:role/aws-service-role/*", Condition = { StringEquals = { "iam:AWSServiceName" = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "elasticache.amazonaws.com", "grafana.amazonaws.com"] } } },
      { Sid = "IamAttachments", Effect = "Allow", Action = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], Resource = local.iam_roles, Condition = { ArnLike = { "iam:PolicyARN" = local.attachable_policies } } },
      merge({ Sid = "PlanStoreLogs" }, local.plan_store_statement),
      { Sid = "ApplicationState", Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${local.state_bucket}/${local.state_key}" },
      { Sid = "ApplicationStateLocks", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-terraform-state-locks", Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = local.state_lock_keys } } }
    ]
  })
}
# A full plan reads every resource type in _infra, so reads come from AWS's
# own read-only policy rather than a hand-kept list.
resource "aws_iam_role_policy_attachment" "sandbox_terraform_read_only" {
  count      = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
  depends_on = [aws_iam_role.sandbox_terraform]
}
resource "aws_iam_policy" "sandbox_terraform_delivery" {
  count  = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  name   = "meeting-notes-sandbox-terraform-delivery"
  policy = local.delivery_policy
}
resource "aws_iam_role_policy_attachment" "sandbox_terraform_delivery" {
  count      = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.sandbox_terraform_delivery[0].arn
  depends_on = [aws_iam_role.sandbox_terraform]
}

locals {
  delivery_guardrails = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ProductionNamedResources", Effect = "Deny", Action = "*", Resource = local.production_named_resources },
      { Sid = "StateReadsOnlySandbox", Effect = "Deny", Action = ["s3:GetObject", "s3:GetObjectVersion"], NotResource = ["arn:aws:s3:::${local.state_bucket}/${local.state_key}", "arn:aws:s3:::${local.state_bucket}/terraform-plans/sandbox/*"] },
      { Sid = "OwnIdentity", Effect = "Deny", NotAction = ["iam:Get*", "iam:List*"], Resource = ["${local.terraform_role_arn}*", "${local.iam_arn}:policy/meeting-notes-sandbox-terraform*", "${local.iam_arn}:oidc-provider/*"] },
      { Sid = "RolesOutsideApplication", Effect = "Deny", Action = ["iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PassRole"], NotResource = local.iam_roles },
      { Sid = "PrivilegedPolicies", Effect = "Deny", Action = ["iam:AttachRolePolicy", "iam:AttachUserPolicy", "iam:AttachGroupPolicy"], Resource = "*", Condition = { ArnEquals = { "iam:PolicyARN" = ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/IAMFullAccess", "arn:aws:iam::aws:policy/PowerUserAccess"] } } },
      { Sid = "BootstrapState", Effect = "Deny", Action = ["s3:PutObject", "s3:DeleteObject*"], Resource = "arn:aws:s3:::${local.state_bucket}/meeting-notes-terraform/*-bootstrap/*" },
      # ReadOnlyAccess would otherwise read meeting data, which Terraform never needs.
      { Sid = "CustomerData", Effect = "Deny", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PartiQLSelect", "dynamodb:GetRecords", "dynamodb:Export*", "s3:GetObject*", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:ListVectors"], Resource = ["arn:aws:dynamodb:${local.region_account}:table/meeting-notes-sandbox-*", "arn:aws:s3:::meeting-notes-sandbox-*/*", "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-*/index/*"] },
      # The GitHub provider is shared and production-tagged. Only its metadata read
      # may cross the tag boundary; every write and other provider read stays denied.
      { Sid = "ProductionResources", Effect = "Deny", NotAction = "iam:GetOpenIDConnectProvider", Resource = "*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "prod" } } },
      { Sid = "ProductionOidcMetadata", Effect = "Deny", Action = "iam:GetOpenIDConnectProvider", NotResource = "${local.iam_arn}:oidc-provider/token.actions.githubusercontent.com", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "prod" } } }
    ]
  })
}

# The Plan role may read refresh inputs, lock state and create write-once
# plan-store objects. Only Terraform Plan in Sandbox can assume it.
resource "aws_iam_role" "sandbox_terraform_plan" {
  count                = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  name                 = "${local.terraform_role_name}-plan"
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
        "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
        "token.actions.githubusercontent.com:workflow"            = "Terraform Plan"
      } }
    }]
  })
}
resource "aws_iam_role_policy_attachment" "sandbox_terraform_plan_read_only" {
  count      = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  role       = aws_iam_role.sandbox_terraform_plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
resource "aws_iam_role_policy" "sandbox_terraform_plan" {
  count = var.enable_sandbox_terraform_delivery && var.enable_sandbox_terraform_role ? 1 : 0
  name  = "meeting-notes-sandbox-terraform-plan"
  role  = aws_iam_role.sandbox_terraform_plan[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ProductionNamedResources", Effect = "Deny", Action = "*", Resource = local.production_named_resources },
      { Sid = "StateReadsOnlySandbox", Effect = "Deny", Action = ["s3:GetObject", "s3:GetObjectVersion"], NotResource = ["arn:aws:s3:::${local.state_bucket}/${local.state_key}", "arn:aws:s3:::${local.state_bucket}/terraform-plans/sandbox/*"] },
      # The GitHub provider is shared and production-tagged. Only its metadata read
      # may cross the tag boundary; every write and other provider read stays denied.
      { Sid = "ProductionResources", Effect = "Deny", NotAction = "iam:GetOpenIDConnectProvider", Resource = "*", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "prod" } } },
      { Sid = "ProductionOidcMetadata", Effect = "Deny", Action = "iam:GetOpenIDConnectProvider", NotResource = "${local.iam_arn}:oidc-provider/token.actions.githubusercontent.com", Condition = { StringEquals = { "aws:ResourceTag/Environment" = "prod" } } },
      { Sid = "StateLock", Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = "arn:aws:dynamodb:${local.region_account}:table/meeting-notes-terraform-state-locks", Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = local.state_lock_keys } } },
      merge({ Sid = "PlanStore" }, local.plan_store_statement),
      { Sid = "SearchTagMetadata", Effect = "Allow", Action = "s3vectors:ListTagsForResource", Resource = [local.sandbox_search_bucket_arn, "${local.sandbox_search_bucket_arn}/index/*"] },
      { Sid = "SecretRefresh", Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = "arn:aws:secretsmanager:${local.region_account}:secret:meeting-notes-sandbox/*" },
      { Sid = "SecretDecrypt", Effect = "Allow", Action = "kms:Decrypt", Resource = "arn:aws:kms:${local.region_account}:key/*", Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.us-east-1.amazonaws.com", "aws:ResourceTag/Environment" = "sandbox" } } },
      { Sid = "CustomerData", Effect = "Deny", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PartiQLSelect", "dynamodb:GetRecords", "dynamodb:Export*", "s3:GetObject*", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:ListVectors"], Resource = ["arn:aws:dynamodb:${local.region_account}:table/meeting-notes-sandbox-*", "arn:aws:s3:::meeting-notes-sandbox-*/*", "arn:aws:s3vectors:${local.region_account}:bucket/meeting-notes-sandbox-*/index/*"] }
    ]
  })
}

output "terraform_plan_role_arn" {
  value = var.enable_sandbox_terraform_delivery ? aws_iam_role.sandbox_terraform_plan[0].arn : null
}
