# Attach only to the existing deployment principal during separately approved introduction.
# Runtime task roles deliberately receive no listener-write permission.
resource "aws_iam_policy" "deployment_routing" {
  count = length(aws_lb_listener.api_https) > 0 ? 1 : 0
  name  = "${local.name_prefix}-deployment-routing"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:ModifyListener"]
        Resource = [aws_lb_listener.api_https[0].arn]
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:ListServiceDeployments"]
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service"
      },
      {
        Effect = "Allow"
        Action = ["ecs:DescribeServiceDeployments", "ecs:DescribeServiceRevisions"]
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service",
          "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service-deployment/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service/*",
          "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service-revision/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service/*"
        ]
      }
    ]
  })
}
output "deployment_routing_policy_arn" {
  value = length(aws_iam_policy.deployment_routing) > 0 ? aws_iam_policy.deployment_routing[0].arn : ""
}
