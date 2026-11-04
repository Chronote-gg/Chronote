variable "artifact_app_kms_key_arn" {
  type    = string
  default = ""
  validation {
    condition     = (var.artifact_app_kms_key_arn == "" && var.artifact_transcripts_bucket == "") || (can(regex("^arn:aws:kms:us-east-1:${var.production_account_id}:key/[a-f0-9-]{36}$", var.artifact_app_kms_key_arn)) && can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.artifact_transcripts_bucket)) && !strcontains(var.artifact_transcripts_bucket, ".."))
    error_message = "Artifact IAM opt-in requires the exact existing application key and transcript bucket."
  }
}
variable "artifact_transcripts_bucket" {
  type    = string
  default = ""
}
locals {
  artifact_iam_grants = concat([
    { Sid = "ArtifactPolicyVersions", Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:CreatePolicyVersion"], Resource = "arn:aws:iam::${var.production_account_id}:policy/meeting-notes-prod-bot-transcripts-s3-policy" },
    { Sid = "ArtifactBackendPolicy", Effect = "Allow", Action = "iam:PutRolePolicy", Resource = "arn:aws:iam::${var.production_account_id}:role/meeting-notes-prod-github-deploy" },
    { Sid = "ArtifactRoleMetadata", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"], Resource = [for suffix in ["ecs-task-app-role", "ecs-task-exec-role"] : "arn:aws:iam::${var.production_account_id}:role/meeting-notes-prod-${suffix}"] },
    { Sid = "ArtifactTranscriptMetadata", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging"], Resource = "arn:aws:s3:::${var.artifact_transcripts_bucket}" },
    { Sid = "ArtifactApplicationKeyMetadata", Effect = "Allow", Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"], Resource = var.artifact_app_kms_key_arn }
  ], [])
  artifact_iam_statements = [for statement in concat(slice(local.artifact_iam_grants, 0, 2), [{
    Sid      = "ArtifactMetadata", Effect = "Allow"
    Action   = distinct(flatten([for s in slice(local.artifact_iam_grants, 2, length(local.artifact_iam_grants)) : s.Action]))
    Resource = distinct(flatten([for s in slice(local.artifact_iam_grants, 2, length(local.artifact_iam_grants)) : [s.Resource]]))
  }]) : statement if var.artifact_app_kms_key_arn != ""]

}
