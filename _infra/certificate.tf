# Optional ACM certificate + DNS for custom frontend domain
# Creates only if both FRONTEND_DOMAIN and HOSTED_ZONE_NAME are set and no external cert ARN is provided

data "aws_route53_zone" "frontend_hosted_zone" {
  count = var.FRONTEND_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0
  name  = var.HOSTED_ZONE_NAME
}

data "aws_route53_zone" "docs_hosted_zone" {
  count = var.DOCS_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0
  name  = var.HOSTED_ZONE_NAME
}

resource "aws_acm_certificate" "frontend_cert" {
  count                     = var.FRONTEND_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" && var.FRONTEND_CERT_ARN == "" ? 1 : 0
  domain_name               = var.FRONTEND_DOMAIN
  validation_method         = "DNS"
  subject_alternative_names = []
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "docs_cert" {
  count                     = var.DOCS_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" && var.DOCS_CERT_ARN == "" ? 1 : 0
  domain_name               = var.DOCS_DOMAIN
  validation_method         = "DNS"
  subject_alternative_names = []

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "frontend_cert_validation" {
  for_each = length(aws_acm_certificate.frontend_cert) > 0 ? {
    for dvo in aws_acm_certificate.frontend_cert[0].domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  name    = each.value.name
  type    = each.value.type
  zone_id = data.aws_route53_zone.frontend_hosted_zone[0].zone_id
  records = [each.value.value]
  ttl     = 300
}

resource "aws_route53_record" "docs_cert_validation" {
  for_each = length(aws_acm_certificate.docs_cert) > 0 ? {
    for dvo in aws_acm_certificate.docs_cert[0].domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  name    = each.value.name
  type    = each.value.type
  zone_id = data.aws_route53_zone.docs_hosted_zone[0].zone_id
  records = [each.value.value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "frontend_cert" {
  count                   = length(aws_acm_certificate.frontend_cert)
  certificate_arn         = aws_acm_certificate.frontend_cert[0].arn
  validation_record_fqdns = [for r in aws_route53_record.frontend_cert_validation : r.fqdn]
}

resource "aws_acm_certificate_validation" "docs_cert" {
  count                   = length(aws_acm_certificate.docs_cert)
  certificate_arn         = aws_acm_certificate.docs_cert[0].arn
  validation_record_fqdns = [for r in aws_route53_record.docs_cert_validation : r.fqdn]
}

# Alias record to CloudFront distribution when custom domain is set
resource "aws_route53_record" "frontend_alias" {
  count = var.FRONTEND_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0

  zone_id = data.aws_route53_zone.frontend_hosted_zone[0].zone_id
  name    = var.FRONTEND_DOMAIN
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# Alias record to docs CloudFront distribution when custom domain is set
resource "aws_route53_record" "docs_alias" {
  count = var.DOCS_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0

  zone_id = data.aws_route53_zone.docs_hosted_zone[0].zone_id
  name    = var.DOCS_DOMAIN
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.docs.domain_name
    zone_id                = aws_cloudfront_distribution.docs.hosted_zone_id
    evaluate_target_health = false
  }
}
