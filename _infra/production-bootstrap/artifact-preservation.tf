# Grants for the production artifact-preservation Plan/Apply scope, which
# targets only the task roles' transcripts S3 policy.
#
# This grant cannot go in the role's inline policy: that policy renders at
# 10,050 characters against IAM's 10,240-character inline limit, which AWS
# counts with whitespace removed, and the grant costs about 80. So the same flag
# that adds the grant also moves the role's read-only dependency metadata and
# discovery statements out of the inline policy and into this one, where they do
# not count against that limit. That is what buys the headroom: 8,280 inline
# characters with the flag on, 1,960 of room.
#
# Effective permissions are unchanged by the move. With the flag off the
# statements stay inline in their original positions, so the default rendering
# is byte for byte the installed one and the initial eight-resource bootstrap
# and its reviewed guard are untouched. Either the administrator opts in and
# gets the grant and the headroom together, or nothing moves at all.
variable "enable_artifact_preservation_policy" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_artifact_preservation_policy || var.enable_production_terraform_role
    error_message = "The artifact preservation policy attaches to the production Terraform role."
  }
}
locals {
  inline_dependency_metadata = !var.enable_artifact_preservation_policy
  transcripts_policy_arn     = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-bot-transcripts-s3-policy"
  # Split only so the inline policy can keep both groups where they already are.
  identity_metadata_statements = [
    { Sid = "GitHubProviderMetadata", Effect = "Allow", Action = "iam:GetOpenIDConnectProvider", Resource = "arn:aws:iam::${var.production_account_id}:oidc-provider/token.actions.githubusercontent.com" },
    { Sid = "SecretMetadata", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"], Resource = "arn:aws:secretsmanager:us-east-1:${var.production_account_id}:secret:meeting-notes-prod/*" }
  ]
  regional_metadata_statements = [
    { Sid = "ClusterMetadata", Effect = "Allow", Action = ["ecs:DescribeClusters", "ecs:ListTagsForResource"], Resource = "arn:aws:ecs:us-east-1:${var.production_account_id}:cluster/meeting-notes-prod-bot-cluster" },
    { Sid = "CertificateMetadata", Effect = "Allow", Action = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"], Resource = var.production_certificate_arn },
    { Sid = "ZoneMetadata", Effect = "Allow", Action = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource"], Resource = "arn:aws:route53:::hostedzone/${var.production_hosted_zone_id}" },
    { Sid = "ZoneDiscovery", Effect = "Allow", Action = "route53:ListHostedZones", Resource = "*" },
    { Sid = "RegionalMetadata", Effect = "Allow", Action = ["ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeCapacityReservation", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeListenerCertificates", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTags"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } }
  ]
  dependency_metadata_statements = concat(local.identity_metadata_statements, local.regional_metadata_statements)
}
resource "aws_iam_policy" "artifact_preservation" {
  count = var.enable_artifact_preservation_policy ? 1 : 0
  name  = "meeting-notes-prod-terraform-artifact-preservation"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      # The policy already exists, so no CreatePolicy. No DeletePolicyVersion:
      # a prune at the five-version limit must stop for a separately reviewed
      # permission change, as it does for the routing policy.
      { Sid = "TranscriptsPolicy", Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags", "iam:CreatePolicyVersion"], Resource = local.transcripts_policy_arn }
    ], local.dependency_metadata_statements)
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy_attachment" "artifact_preservation" {
  count      = var.enable_artifact_preservation_policy ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.artifact_preservation[0].arn
  depends_on = [aws_iam_role.production_terraform]
  lifecycle { prevent_destroy = true }
}
