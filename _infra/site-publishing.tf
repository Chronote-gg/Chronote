resource "aws_iam_policy" "site_publishing" {
  count = contains(["prod", "sandbox"], var.environment) ? 1 : 0
  name  = "${local.name_prefix}-site-publishing"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SiteBuckets"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.frontend.arn, aws_s3_bucket.docs.arn]
      },
      {
        Sid      = "SiteObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
        Resource = ["${aws_s3_bucket.frontend.arn}/*", "${aws_s3_bucket.docs.arn}/*"]
      },
      {
        Sid      = "SiteInvalidation"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = [aws_cloudfront_distribution.frontend.arn, aws_cloudfront_distribution.docs.arn]
      },
      {
        Sid      = "DocsPreflightAndWait"
        Effect   = "Allow"
        Action   = ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"]
        Resource = [aws_cloudfront_distribution.docs.arn]
      },
      {
        Sid      = "SiteObjectEncryption"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = [aws_kms_key.app_general.arn]
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
            "kms:ViaService"    = "s3.${var.aws_region}.amazonaws.com"
          }
          StringLike = {
            "kms:EncryptionContext:aws:s3:arn" = ["${aws_s3_bucket.frontend.arn}/*", "${aws_s3_bucket.docs.arn}/*"]
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "site_publishing" {
  count      = contains(["prod", "sandbox"], var.environment) ? 1 : 0
  role       = var.environment == "prod" ? aws_iam_role.production_deploy[0].name : aws_iam_role.sandbox_deploy[0].name
  policy_arn = aws_iam_policy.site_publishing[0].arn
}
