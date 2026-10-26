resource "aws_s3_bucket" "private_evidence" {
  #checkov:skip=CKV_AWS_18 reason: The reviewed eight-resource bootstrap has no access-log destination. Add logging only with an approved private destination and ownership plan.
  #checkov:skip=CKV_AWS_144 reason: The reviewed evidence design has no replication or second-region destination. Replication needs separate ownership and privacy review.
  #checkov:skip=CKV2_AWS_61 reason: Evidence expiration is forbidden while reviewed retention is active. A lifecycle change requires an approved retention decision.
  #checkov:skip=CKV2_AWS_62 reason: This capture store has no event consumer. Notifications would introduce an unreviewed destination outside the eight-resource bootstrap.
  count         = var.enable_private_evidence_store ? 1 : 0
  bucket        = local.bucket_name
  force_destroy = false
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_caller_identity.current[0].account_id == var.sandbox_account_id && data.aws_kms_key.existing[0].arn == var.kms_key_arn && data.aws_kms_key.existing[0].key_state == "Enabled"
      error_message = "Account and existing enabled key must match the private sandbox binding."
    }
    precondition {
      condition     = alltrue([for principal in [var.administrator_role_arn, var.reviewer_role_arn] : !contains([local.terraform_role_arn, local.app_role_arn, "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-ecs-task-exec-role"], principal)])
      error_message = "Administrator and reviewer must exclude executor and runtime roles."
    }
  }
}
resource "aws_s3_bucket_public_access_block" "private_evidence" {
  count                   = var.enable_private_evidence_store ? 1 : 0
  bucket                  = local.bucket_name
  depends_on              = [aws_s3_bucket.private_evidence]
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_ownership_controls" "private_evidence" {
  count      = var.enable_private_evidence_store ? 1 : 0
  bucket     = local.bucket_name
  depends_on = [aws_s3_bucket.private_evidence]
  rule { object_ownership = "BucketOwnerEnforced" }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "private_evidence" {
  count      = var.enable_private_evidence_store ? 1 : 0
  bucket     = local.bucket_name
  depends_on = [aws_s3_bucket.private_evidence]
  versioning_configuration { status = "Enabled" }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "private_evidence" {
  count      = var.enable_private_evidence_store ? 1 : 0
  bucket     = local.bucket_name
  depends_on = [aws_s3_bucket.private_evidence]
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = false
  }
  lifecycle { prevent_destroy = true }
}
locals {
  bucket_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid = "OnlyReviewedPrincipals", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { ArnNotEquals = { "aws:PrincipalArn" = [var.administrator_role_arn, var.reviewer_role_arn, local.terraform_role_arn] } } },
      { Sid = "CaptureCannotAdminister", Effect = "Deny", Principal = "*", NotAction = concat(local.capture_reads, ["s3:PutObject", "s3:GetObjectVersion"]), Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { ArnEquals = { "aws:PrincipalArn" = local.terraform_role_arn } } },
      { Sid = "ReviewerCannotWrite", Effect = "Deny", Principal = "*", NotAction = concat(local.capture_reads, ["s3:GetObjectVersion", "s3:ListBucketVersions"]), Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { ArnEquals = { "aws:PrincipalArn" = var.reviewer_role_arn }, ArnNotEquals = { "aws:PrincipalArn" = var.administrator_role_arn } } },
      { Sid = "ReviewerNamespaceListOnly", Effect = "Deny", Principal = "*", Action = "s3:ListBucketVersions", Resource = local.bucket_arn, Condition = { ArnEquals = { "aws:PrincipalArn" = var.reviewer_role_arn }, ArnNotEquals = { "aws:PrincipalArn" = var.administrator_role_arn }, StringNotLike = { "s3:prefix" = "terraform/sandbox/*" } } },
      { Sid = "CaptureNamespaceOnly", Effect = "Deny", Principal = "*", Action = ["s3:PutObject", "s3:GetObjectVersion"], NotResource = local.capture_objects, Condition = { ArnEquals = { "aws:PrincipalArn" = [local.terraform_role_arn, var.reviewer_role_arn] }, ArnNotEquals = { "aws:PrincipalArn" = var.administrator_role_arn } } },
      { Sid = "ConditionalCreateOnly", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${local.bucket_arn}/*", Condition = { StringNotEquals = { "s3:if-none-match" = "*" } } },
      { Sid = "ExactKMSAlgorithm", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${local.bucket_arn}/*", Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } } },
      { Sid = "ExactKMSKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${local.bucket_arn}/*", Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = var.kms_key_arn } } },
      { Sid = "ControlReadback", Effect = "Allow", Principal = { AWS = local.account_root }, Action = local.capture_reads, Resource = local.bucket_arn, Condition = { ArnEquals = { "aws:PrincipalArn" = [local.terraform_role_arn, var.reviewer_role_arn] } } },
      { Sid = "ConditionalCapture", Effect = "Allow", Principal = { AWS = local.account_root }, Action = "s3:PutObject", Resource = local.capture_objects, Condition = { ArnEquals = { "aws:PrincipalArn" = local.terraform_role_arn }, StringEquals = { "s3:if-none-match" = "*", "s3:x-amz-server-side-encryption" = "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id" = var.kms_key_arn } } },
      { Sid = "ExactVersionReview", Effect = "Allow", Principal = { AWS = local.account_root }, Action = "s3:GetObjectVersion", Resource = local.capture_objects, Condition = { ArnEquals = { "aws:PrincipalArn" = [local.terraform_role_arn, var.reviewer_role_arn] } } }
    ]
  })
}
resource "aws_s3_bucket_policy" "private_evidence" {
  count      = var.enable_private_evidence_store ? 1 : 0
  bucket     = local.bucket_name
  depends_on = [aws_s3_bucket.private_evidence]
  policy     = local.bucket_policy
  lifecycle { prevent_destroy = true }
}
