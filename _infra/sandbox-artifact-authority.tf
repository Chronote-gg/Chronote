# Keep the legacy Sandbox artifact grant independent of application resources.
resource "aws_iam_policy" "sandbox_artifact_authority" {
  count = var.environment == "sandbox" ? 1 : 0
  name  = "${local.name_prefix}-artifact-authority"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ArtifactAuthorityChecks"
      Effect   = "Allow"
      Action   = ["dynamodb:ConditionCheckItem"]
      Resource = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name_prefix}-MeetingHistoryTable"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "sandbox_artifact_authority" {
  count      = var.environment == "sandbox" ? 1 : 0
  role       = aws_iam_role.sandbox_deploy[0].name
  policy_arn = aws_iam_policy.sandbox_artifact_authority[0].arn
}
