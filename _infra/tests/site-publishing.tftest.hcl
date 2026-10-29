mock_provider "aws" {
  override_during = plan
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock-site-policy" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}
mock_provider "github" {
  mock_data "github_repository" {
    defaults = { repo_id = 12345, name = "Chronote" }
  }
  mock_data "github_organization" {
    defaults = { id = "67890" }
  }
}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN       = "mock"
  AWS_TOKEN_KEY      = "mock"
  DISCORD_CLIENT_ID  = "mock"
  ENABLE_ELASTICACHE = false
  ENABLE_API_ALB     = true
  API_DOMAIN         = "sandbox.example.test"
  API_CERT_ARN       = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
}

run "production_site_policy" {
  command = plan
  plan_options { target = [aws_iam_policy.site_publishing, aws_iam_role_policy_attachment.site_publishing] }
  variables {
    environment              = "prod"
    github_environment       = "production"
    frontend_distribution_id = "EPRODFRONTEND"
    docs_distribution_id     = "EPRODDOCS"
  }
  override_resource {
    target          = aws_s3_bucket.frontend
    override_during = plan
    values          = { arn = "arn:aws:s3:::meeting-notes-prod-frontend-123456789012" }
  }
  override_resource {
    target          = aws_s3_bucket.docs
    override_during = plan
    values          = { arn = "arn:aws:s3:::meeting-notes-prod-docs-123456789012" }
  }
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values          = { id = "should-not-be-read", arn = "should-not-be-read" }
  }
  override_resource {
    target          = aws_cloudfront_distribution.docs
    override_during = plan
    values          = { id = "should-not-be-read", arn = "should-not-be-read" }
  }
  override_resource {
    target          = aws_kms_key.app_general
    override_during = plan
    values          = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
  override_resource {
    target          = aws_iam_role.production_deploy[0]
    override_during = plan
    values          = { name = "meeting-notes-prod-github-deploy" }
  }
  assert {
    condition     = length(aws_iam_policy.site_publishing) == 1 && length(aws_iam_role_policy_attachment.site_publishing) == 1
    error_message = "Production must have one site policy and one attachment."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.site_publishing[0].role == "meeting-notes-prod-github-deploy" && aws_iam_role_policy_attachment.site_publishing[0].policy_arn == aws_iam_policy.site_publishing[0].arn
    error_message = "Production site policy must attach only to the existing production deployment role."
  }
  assert {
    condition = jsondecode(aws_iam_policy.site_publishing[0].policy) == {
      Version = "2012-10-17"
      Statement = [
        { Sid = "SiteBuckets", Effect = "Allow", Action = ["s3:ListBucket"], Resource = ["arn:aws:s3:::meeting-notes-prod-frontend-123456789012", "arn:aws:s3:::meeting-notes-prod-docs-123456789012"] },
        { Sid = "SiteObjects", Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource = ["arn:aws:s3:::meeting-notes-prod-frontend-123456789012/*", "arn:aws:s3:::meeting-notes-prod-docs-123456789012/*"] },
        { Sid = "SiteInvalidation", Effect = "Allow", Action = ["cloudfront:CreateInvalidation"], Resource = ["arn:aws:cloudfront::123456789012:distribution/EPRODFRONTEND", "arn:aws:cloudfront::123456789012:distribution/EPRODDOCS"] },
        { Sid = "DocsPreflightAndWait", Effect = "Allow", Action = ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"], Resource = ["arn:aws:cloudfront::123456789012:distribution/EPRODDOCS"] },
        { Sid = "SiteObjectEncryption", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = ["arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111"], Condition = { StringEquals = { "kms:CallerAccount" = "123456789012", "kms:ViaService" = "s3.us-east-1.amazonaws.com" }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = ["arn:aws:s3:::meeting-notes-prod-frontend-123456789012/*", "arn:aws:s3:::meeting-notes-prod-docs-123456789012/*"] } } }
      ]
    }
    error_message = "Production policy must contain exactly the five site-only permission groups, actions, resources and KMS conditions."
  }
  assert {
    condition     = length(regexall("\\s", aws_iam_policy.site_publishing[0].policy)) + 6144 >= length(aws_iam_policy.site_publishing[0].policy)
    error_message = "Managed policy must fit the 6,144 non-whitespace-character IAM limit."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.site_publishing[0].policy).Statement : !contains(flatten([s.Resource]), "*") && alltrue([for a in s.Action : !contains(["s3:GetObject", "s3:PutObjectAcl", "s3:DeleteObjectVersion", "kms:Encrypt", "cloudfront:UpdateDistribution"], a)])])
    error_message = "Site policy must exclude wildcard resources and speculative read, ACL, version, key and distribution grants."
  }
}

run "sandbox_site_policy" {
  command = plan
  plan_options { target = [aws_iam_policy.site_publishing, aws_iam_role_policy_attachment.site_publishing] }
  variables {
    environment              = "sandbox"
    github_environment       = "sandbox"
    frontend_distribution_id = "ESANDBOXFRONTEND"
    docs_distribution_id     = "ESANDBOXDOCS"
  }
  override_resource {
    target          = aws_s3_bucket.frontend
    override_during = plan
    values          = { arn = "arn:aws:s3:::meeting-notes-sandbox-frontend-123456789012" }
  }
  override_resource {
    target          = aws_s3_bucket.docs
    override_during = plan
    values          = { arn = "arn:aws:s3:::meeting-notes-sandbox-docs-123456789012" }
  }
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values          = { id = "should-not-be-read", arn = "should-not-be-read" }
  }
  override_resource {
    target          = aws_cloudfront_distribution.docs
    override_during = plan
    values          = { id = "should-not-be-read", arn = "should-not-be-read" }
  }
  override_resource {
    target          = aws_kms_key.app_general
    override_during = plan
    values          = { arn = "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-2222-2222-222222222222" }
  }
  override_resource {
    target          = aws_iam_role.sandbox_deploy[0]
    override_during = plan
    values          = { name = "meeting-notes-sandbox-github-deploy" }
  }
  assert {
    condition     = length(aws_iam_policy.site_publishing) == 1 && length(aws_iam_role_policy_attachment.site_publishing) == 1 && aws_iam_role_policy_attachment.site_publishing[0].role == "meeting-notes-sandbox-github-deploy" && aws_iam_role_policy_attachment.site_publishing[0].policy_arn == aws_iam_policy.site_publishing[0].arn
    error_message = "Sandbox must attach its site policy to the existing Sandbox role."
  }
  assert {
    condition = jsondecode(aws_iam_policy.site_publishing[0].policy) == {
      Version = "2012-10-17"
      Statement = [
        { Sid = "SiteBuckets", Effect = "Allow", Action = ["s3:ListBucket"], Resource = ["arn:aws:s3:::meeting-notes-sandbox-frontend-123456789012", "arn:aws:s3:::meeting-notes-sandbox-docs-123456789012"] },
        { Sid = "SiteObjects", Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource = ["arn:aws:s3:::meeting-notes-sandbox-frontend-123456789012/*", "arn:aws:s3:::meeting-notes-sandbox-docs-123456789012/*"] },
        { Sid = "SiteInvalidation", Effect = "Allow", Action = ["cloudfront:CreateInvalidation"], Resource = ["arn:aws:cloudfront::123456789012:distribution/ESANDBOXFRONTEND", "arn:aws:cloudfront::123456789012:distribution/ESANDBOXDOCS"] },
        { Sid = "DocsPreflightAndWait", Effect = "Allow", Action = ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"], Resource = ["arn:aws:cloudfront::123456789012:distribution/ESANDBOXDOCS"] },
        { Sid = "SiteObjectEncryption", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = ["arn:aws:kms:us-east-1:123456789012:key/22222222-2222-2222-2222-222222222222"], Condition = { StringEquals = { "kms:CallerAccount" = "123456789012", "kms:ViaService" = "s3.us-east-1.amazonaws.com" }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = ["arn:aws:s3:::meeting-notes-sandbox-frontend-123456789012/*", "arn:aws:s3:::meeting-notes-sandbox-docs-123456789012/*"] } } }
      ]
    }
    error_message = "Sandbox policy must use only Sandbox sites, key, actions and regional S3 KMS conditions."
  }
  assert {
    condition     = length(regexall("\\s", aws_iam_policy.site_publishing[0].policy)) + 6144 >= length(aws_iam_policy.site_publishing[0].policy)
    error_message = "Sandbox managed policy must fit the IAM size limit."
  }
}

run "site_policy_requires_distribution_ids" {
  command = plan
  plan_options { target = [aws_iam_policy.site_publishing] }
  variables {
    environment        = "prod"
    github_environment = "production"
  }
  expect_failures = [aws_iam_policy.site_publishing]
}

run "distribution_ids_must_be_cloudfront_ids" {
  command = plan
  plan_options { target = [aws_iam_policy.site_publishing] }
  variables {
    environment              = "prod"
    github_environment       = "production"
    frontend_distribution_id = "*"
    docs_distribution_id     = "arn:aws:cloudfront::123456789012:distribution/EPRODDOCS"
  }
  expect_failures = [var.frontend_distribution_id, var.docs_distribution_id]
}

run "mismatched_distribution_id_fails_the_distribution" {
  command = plan
  plan_options { target = [aws_cloudfront_distribution.frontend] }
  variables { frontend_distribution_id = "EOTHER" }
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values          = { id = "EPRODFRONTEND" }
  }
  expect_failures = [aws_cloudfront_distribution.frontend]
}

run "unsupported_environment_has_no_site_grant" {
  command = plan
  plan_options { target = [aws_iam_policy.site_publishing, aws_iam_role_policy_attachment.site_publishing] }
  variables { environment = "dev" }
  assert {
    condition     = length(aws_iam_policy.site_publishing) == 0 && length(aws_iam_role_policy_attachment.site_publishing) == 0
    error_message = "Only production and Sandbox may create or attach the site policy."
  }
}

# validate-site-plan.cjs names these exact values; keep both sides aligned.
run "site_delivery_matches_its_plan_validator" {
  command = plan
  plan_options {
    target = [aws_cloudfront_distribution.frontend, aws_cloudfront_distribution.docs, aws_cloudfront_function.frontend_route_rewrite, aws_cloudfront_response_headers_policy.crawler_noindex]
  }
  variables {
    environment        = "prod"
    github_environment = "production"
  }
  assert {
    condition     = aws_cloudfront_function.frontend_route_rewrite.name == "meeting-notes-prod-frontend-route-rewrite" && aws_cloudfront_function.frontend_route_rewrite.runtime == "cloudfront-js-2.0" && aws_cloudfront_function.frontend_route_rewrite.publish && aws_cloudfront_response_headers_policy.crawler_noindex.name == "meeting-notes-prod-crawler-noindex"
    error_message = "Function and headers policy names must match the site plan validator."
  }
  assert {
    condition     = [for r in aws_cloudfront_distribution.frontend.custom_error_response : [r.error_code, r.response_code, r.response_page_path, r.error_caching_min_ttl]] == [[403, 404, "/404.html", 0]]
    error_message = "The frontend serves only the real 404 page for missing objects."
  }
  assert {
    condition     = [for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.path_pattern] == ["/assets/*", "/share/*"] && [for b in aws_cloudfront_distribution.docs.ordered_cache_behavior : b.path_pattern] == ["/assets/*", "/search*"]
    error_message = "Each distribution gains exactly the behaviors the site plan validator expects."
  }
  assert {
    condition     = [for f in one(aws_cloudfront_distribution.frontend.default_cache_behavior).function_association : f.event_type] == ["viewer-request"]
    error_message = "The frontend default behavior runs the route rewrite on viewer requests."
  }
}
