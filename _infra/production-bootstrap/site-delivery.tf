# CloudFront writes for the site-delivery Plan/Apply scope. A managed policy,
# because the role's inline policies already sit near IAM's shared 10,240 limit.
# Reads for the refreshed graph stay in the inline SiteCdnMetadata statement.
variable "enable_site_delivery_policy" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_site_delivery_policy || var.enable_production_terraform_role
    error_message = "The site delivery policy attaches to the production Terraform role."
  }
}
variable "frontend_distribution_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_site_delivery_policy || can(regex("^E[A-Z0-9]+$", var.frontend_distribution_id))
    error_message = "Supply the exact production frontend CloudFront distribution ID."
  }
}
variable "docs_distribution_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_site_delivery_policy || can(regex("^E[A-Z0-9]+$", var.docs_distribution_id))
    error_message = "Supply the exact production docs CloudFront distribution ID."
  }
}
locals {
  cloudfront_arn = "arn:aws:cloudfront::${var.production_account_id}"
}
resource "aws_iam_policy" "site_delivery" {
  count = var.enable_site_delivery_policy ? 1 : 0
  name  = "meeting-notes-prod-terraform-site-delivery"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # GetDistribution for refresh and the deploy wait is granted inline.
      { Sid = "ExistingDistributions", Effect = "Allow", Action = "cloudfront:UpdateDistribution", Resource = ["${local.cloudfront_arn}:distribution/${var.frontend_distribution_id}", "${local.cloudfront_arn}:distribution/${var.docs_distribution_id}"] },
      # Default tags travel with CreateFunction; reads are granted inline.
      { Sid = "RouteRewriteFunction", Effect = "Allow", Action = ["cloudfront:CreateFunction", "cloudfront:PublishFunction", "cloudfront:TagResource"], Resource = "${local.cloudfront_arn}:function/meeting-notes-prod-frontend-route-rewrite" },
      # A policy ID exists only after creation, so no exact ARN can be named.
      { Sid = "CrawlerHeadersPolicy", Effect = "Allow", Action = "cloudfront:CreateResponseHeadersPolicy", Resource = "${local.cloudfront_arn}:response-headers-policy/*" }
    ]
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy_attachment" "site_delivery" {
  count      = var.enable_site_delivery_policy ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.site_delivery[0].arn
  depends_on = [aws_iam_role.production_terraform]
  lifecycle { prevent_destroy = true }
}
