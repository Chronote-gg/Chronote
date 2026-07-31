variable "ENABLE_API_ALB" {
  description = "Provision the public ALB in front of the API. False leaves the bot reachable only outbound (Discord gateway), which is all a bot-only environment needs."
  type        = bool
  default     = true

  validation {
    condition     = var.ENABLE_API_ALB || var.API_DOMAIN != ""
    error_message = "API_DOMAIN must be set when ENABLE_API_ALB is false, because api_base_url has nothing else to resolve to."
  }
}

locals {
  # Never null: interpolating a null into a template errors, and api_base_url
  # references this in an arm Terraform may still evaluate when the ALB is off.
  api_alb_dns_name = coalesce(one(aws_lb.api_alb[*].dns_name), "")
}

variable "ENABLE_API_ALB_DELETION_PROTECTION" {
  description = "Deletion protection on the API ALB. Must be false before ENABLE_API_ALB can be flipped off, or the destroy is refused."
  type        = bool
  default     = true
}

data "aws_route53_zone" "api_hosted_zone" {
  count = var.API_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0
  name  = var.HOSTED_ZONE_NAME
}

resource "aws_acm_certificate" "api_cert" {
  count             = var.API_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" && var.API_CERT_ARN == "" ? 1 : 0
  domain_name       = var.API_DOMAIN
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_cert_validation" {
  for_each = var.API_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" && var.API_CERT_ARN == "" ? {
    (var.API_DOMAIN) = one(aws_acm_certificate.api_cert[0].domain_validation_options)
  } : {}

  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  zone_id = data.aws_route53_zone.api_hosted_zone[0].zone_id
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "api_cert" {
  count                   = var.API_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" && var.API_CERT_ARN == "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.api_cert[0].arn
  validation_record_fqdns = [for r in aws_route53_record.api_cert_validation : r.fqdn]
}

resource "aws_security_group" "api_alb_sg" {
  #checkov:skip=CKV2_AWS_5: Attached to aws_lb.api_alb via a count-indexed reference, which checkov's graph does not resolve.
  count       = var.ENABLE_API_ALB ? 1 : 0
  name_prefix = "${local.name_prefix}-api-alb-"
  description = "ALB SG for ${local.name_prefix} API"
  vpc_id      = aws_vpc.app_vpc.id

  #checkov:skip=CKV_AWS_260: HTTP is enabled only to redirect to HTTPS.
  ingress {
    description = "Allow HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Allow HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow ALB to reach ECS tasks"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_lb" "api_alb" {
  #checkov:skip=CKV_AWS_91: Access logs not yet enabled for the API ALB.
  #checkov:skip=CKV2_AWS_28: WAF not enabled yet; revisit before public launch.
  count                      = var.ENABLE_API_ALB ? 1 : 0
  name                       = "${local.name_prefix}-api"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.api_alb_sg[0].id]
  subnets                    = [aws_subnet.app_public_subnet_1.id, aws_subnet.app_public_subnet_2.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.ENABLE_API_ALB_DELETION_PROTECTION
}

resource "aws_lb_target_group" "api_tg" {
  #checkov:skip=CKV_AWS_378: TLS terminates at the ALB; target group uses HTTP.
  count       = var.ENABLE_API_ALB ? 1 : 0
  name        = "${local.name_prefix}-api-tg"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app_vpc.id

  health_check {
    path                = "/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "api_http" {
  #checkov:skip=CKV_AWS_2: HTTP listener only redirects to HTTPS.
  #checkov:skip=CKV_AWS_103: TLS enforcement handled on HTTPS listener.
  count             = var.ENABLE_API_ALB ? 1 : 0
  load_balancer_arn = aws_lb.api_alb[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "api_https" {
  count             = var.ENABLE_API_ALB && var.API_DOMAIN != "" && (var.API_CERT_ARN != "" || var.HOSTED_ZONE_NAME != "") ? 1 : 0
  load_balancer_arn = aws_lb.api_alb[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.API_CERT_ARN != "" ? var.API_CERT_ARN : aws_acm_certificate.api_cert[0].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api_tg[0].arn
  }

  depends_on = [aws_acm_certificate_validation.api_cert]
}

resource "aws_route53_record" "api_alias" {
  count = var.ENABLE_API_ALB && var.API_DOMAIN != "" && var.HOSTED_ZONE_NAME != "" ? 1 : 0

  zone_id = data.aws_route53_zone.api_hosted_zone[0].zone_id
  name    = var.API_DOMAIN
  type    = "A"

  alias {
    name                   = aws_lb.api_alb[0].dns_name
    zone_id                = aws_lb.api_alb[0].zone_id
    evaluate_target_health = true
  }
}

output "api_alb_dns_name" {
  value = local.api_alb_dns_name
}

output "api_domain" {
  value = var.API_DOMAIN
}
