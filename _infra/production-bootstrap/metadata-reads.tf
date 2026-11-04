# The role's inline policy renders to 10,130 characters against IAM's
# 10,240-character inline limit, which AWS counts with whitespace removed. That
# leaves no room for a further statement, so the role's read-only dependency
# metadata and discovery statements move to a managed policy attached to the
# same role, where they do not count against the inline limit. Effective
# permissions are identical either way: the inline policy omits exactly these
# statements when the flag is set.
#
# The flag defaults false so the initial eight-resource bootstrap and its
# reviewed guard are unchanged. Enable it in the same reviewed apply that adds
# the transcripts managed-policy grant.
variable "enable_metadata_reads_policy" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_metadata_reads_policy || var.enable_production_terraform_role
    error_message = "The metadata reads policy attaches to the production Terraform role."
  }
}
locals {
  dependency_metadata_statements = [
    { Sid = "ClusterMetadata", Effect = "Allow", Action = ["ecs:DescribeClusters", "ecs:ListTagsForResource"], Resource = "arn:aws:ecs:us-east-1:${var.production_account_id}:cluster/meeting-notes-prod-bot-cluster" },
    { Sid = "CertificateMetadata", Effect = "Allow", Action = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"], Resource = var.production_certificate_arn },
    { Sid = "ZoneMetadata", Effect = "Allow", Action = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource"], Resource = "arn:aws:route53:::hostedzone/${var.production_hosted_zone_id}" },
    { Sid = "ZoneDiscovery", Effect = "Allow", Action = "route53:ListHostedZones", Resource = "*" },
    { Sid = "RegionalMetadata", Effect = "Allow", Action = ["ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeCapacityReservation", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeListenerCertificates", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTags"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } },
    { Sid = "GitHubProviderMetadata", Effect = "Allow", Action = "iam:GetOpenIDConnectProvider", Resource = "arn:aws:iam::${var.production_account_id}:oidc-provider/token.actions.githubusercontent.com" },
    { Sid = "SecretMetadata", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"], Resource = "arn:aws:secretsmanager:us-east-1:${var.production_account_id}:secret:meeting-notes-prod/*" }
  ]
}
resource "aws_iam_policy" "metadata_reads" {
  count = var.enable_metadata_reads_policy ? 1 : 0
  name  = "meeting-notes-prod-terraform-metadata-reads"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.dependency_metadata_statements
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy_attachment" "metadata_reads" {
  count      = var.enable_metadata_reads_policy ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.metadata_reads[0].arn
  depends_on = [aws_iam_role.production_terraform]
  lifecycle { prevent_destroy = true }
}
