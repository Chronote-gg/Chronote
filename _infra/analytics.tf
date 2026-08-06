# PostHog managed reverse proxy DNS.
#
# The portal sends analytics to a first-party subdomain instead of
# us.i.posthog.com, because ad blockers filter the latter and silently skew
# every metric downward. PostHog hosts the proxy itself, so there is no
# CloudFront behavior or origin here: the only infrastructure is this CNAME.
#
# The domain is registered in PostHog's organization proxy settings, which
# issues the target below and provisions the certificate once DNS resolves.
# Both values are supplied per environment so a non-production workspace does
# not publish a record pointing at the production proxy.

variable "ANALYTICS_PROXY_DOMAIN" {
  description = "Custom subdomain that fronts PostHog ingestion; leave blank to send directly to PostHog"
  type        = string
  default     = ""
}

variable "ANALYTICS_PROXY_CNAME_TARGET" {
  description = "CNAME target issued by PostHog when the proxy domain is registered"
  type        = string
  default     = ""
}

data "aws_route53_zone" "analytics_proxy_hosted_zone" {
  count = var.ANALYTICS_PROXY_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0
  name  = var.HOSTED_ZONE_NAME
}

resource "aws_route53_record" "analytics_proxy" {
  count = var.ANALYTICS_PROXY_DOMAIN != "" && var.ANALYTICS_PROXY_CNAME_TARGET != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0

  zone_id = data.aws_route53_zone.analytics_proxy_hosted_zone[0].zone_id
  name    = var.ANALYTICS_PROXY_DOMAIN
  type    = "CNAME"
  records = [var.ANALYTICS_PROXY_CNAME_TARGET]
  ttl     = 300
}
