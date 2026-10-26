# Exact reviewed metadata resources, disabled with the existing acceptance authority.
variable "production_introduction_route_role_arns" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for arn in var.production_introduction_route_role_arns : can(regex("^arn:aws:iam::[0-9]{12}:role/[^*?]+$", arn))])
    error_message = "Pin the existing deploy, Apply and prompt guard role ARNs without wildcards."
  }
}
variable "production_introduction_reviewed_policy_arns" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for arn in var.production_introduction_reviewed_policy_arns : can(regex("^arn:aws:iam::(aws|[0-9]{12}):policy/[^*?]+$", arn))])
    error_message = "Pin each attached policy and permissions boundary ARN without wildcards."
  }
}
resource "aws_iam_role_policy" "production_launcher_reads" {
  for_each = local.production_acceptance_enabled ? {
    introduction = aws_iam_role.production_introduction["introduction"].id
    collector    = aws_iam_role.production_acceptance_collector[0].id
  } : {}
  role = each.value
  name = "reviewed-launcher-metadata"
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Sid = "NamedRoleMetadata", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"], Resource = concat(sort(tolist(var.production_introduction_route_role_arns)), [aws_iam_role.production_introduction["introduction"].arn, aws_iam_role.production_acceptance_collector[0].arn, aws_iam_role.ecs_task_app_role.arn, aws_iam_role.ecs_task_execution_role.arn]) },
    { Sid = "DeclaredOidcMetadata", Effect = "Allow", Action = ["iam:GetOpenIDConnectProvider"], Resource = data.aws_iam_openid_connect_provider.production_introduction[0].arn }
    ], length(var.production_introduction_reviewed_policy_arns) == 0 ? [] : [
    { Sid = "DeclaredPolicyMetadata", Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource = sort(tolist(var.production_introduction_reviewed_policy_arns)) }
  ]) })
  lifecycle {
    precondition {
      condition     = length(var.production_introduction_route_role_arns) > 0
      error_message = "The original reviewed package must identify the actual guarded production route roles."
    }
  }
}
