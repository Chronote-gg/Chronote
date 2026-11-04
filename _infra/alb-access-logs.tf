# --- ALB access logs ---
# Without these, a 4xx or 5xx response cannot be attributed to a route, a method
# or a client, so neither the CSRF rejections nor the load-balancer 5xx the new
# alb_elb_5xx_errors alarm now watches can be root-caused after the fact. The
# alarm says an outage happened; this says which requests it happened to.

variable "ENABLE_ALB_ACCESS_LOGS" {
  description = "Collect ALB access logs. Off by default: access logs retain client IP addresses, and the privacy policy promises notice before a change like that takes effect, so this stays false until that notice ships."
  type        = bool
  default     = false
}

locals {
  alb_access_logs_enabled     = var.ENABLE_API_ALB && var.ENABLE_ALB_ACCESS_LOGS
  alb_access_logs_bucket_name = "${local.name_prefix}-alb-logs-${data.aws_caller_identity.current.account_id}"
  alb_access_logs_prefix      = "alb"
}

resource "aws_s3_bucket" "alb_access_logs" {
  #checkov:skip=CKV_AWS_18 reason: This is the log bucket; logging it into itself would recurse.
  #checkov:skip=CKV_AWS_144 reason: Cross-region replication not required for logs expiring in 30 days.
  #checkov:skip=CKV2_AWS_62 reason: Event notifications not needed for a log sink nothing consumes live.
  #checkov:skip=CKV_AWS_145 reason: ALB access log delivery supports only SSE-S3, so a CMK is not an option here.
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = local.alb_access_logs_bucket_name

  tags = {
    Name = "${local.name_prefix}-alb-logs"
  }
}

resource "aws_s3_bucket_public_access_block" "alb_access_logs" {
  count                   = local.alb_access_logs_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.alb_access_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_access_logs" {
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3, not the app_general CMK the other buckets use. Elastic Load Balancing
# refuses to deliver access logs to a bucket encrypted with a customer managed
# key: "The only server-side encryption option that's supported is Amazon
# S3-managed keys (SSE-S3)". A CMK here does not fail loudly, it just means
# logging never starts, so this difference from the other buckets is deliberate.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_access_logs" {
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    blocked_encryption_types = ["SSE-C"]
    bucket_key_enabled       = false

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "alb_access_logs" {
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = aws_s3_bucket.alb_access_logs[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# 30 days: the forensic value of a raw request log drops off quickly, and the
# shorter window also bounds how long client IP addresses are retained. The
# noncurrent rule is not decoration: the bucket is versioned, so expiring the
# current version only writes a delete marker and would otherwise keep those IPs
# indefinitely.
resource "aws_s3_bucket_lifecycle_configuration" "alb_access_logs" {
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {
      prefix = ""
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# The modern log delivery service principal, which AWS documents for every
# region. The regional Elastic Load Balancing account id (127311923021 for
# us-east-1) is the legacy policy: still accepted, but AWS recommends replacing
# it, and it is the form that silently stops working outside the older regions.
# SourceArn restricts writes to this account's load balancers, and the account id
# in the object path is AWS's documented requirement rather than a nicety.
data "aws_iam_policy_document" "alb_access_logs" {
  count = local.alb_access_logs_enabled ? 1 : 0

  statement {
    sid    = "AllowELBLogDelivery"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_access_logs[0].arn}/${local.alb_access_logs_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:loadbalancer/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_access_logs" {
  count  = local.alb_access_logs_enabled ? 1 : 0
  bucket = aws_s3_bucket.alb_access_logs[0].id
  policy = data.aws_iam_policy_document.alb_access_logs[0].json
}
