terraform {
  required_version = "= 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.1"
    }
  }
  backend "s3" {
    region               = "us-east-1"
    bucket               = "meeting-notes-terraform-state-bucket"
    key                  = "meeting-notes-terraform/sandbox-bootstrap/state"
    dynamodb_table       = "meeting-notes-terraform-state-locks"
    workspace_key_prefix = "meeting-notes-terraform/sandbox-bootstrap/workspaces"
    encrypt              = true
  }
}
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.enable_private_evidence_store ? [var.sandbox_account_id] : null
  default_tags {
    tags = { Project = "meeting-notes", Environment = "sandbox", ManagedBy = "terraform", Service = "chronote" }
  }
}
variable "enable_private_evidence_store" {
  type    = bool
  default = false
  validation {
    condition = !var.enable_private_evidence_store || (
      var.environment == "sandbox" && var.aws_region == "us-east-1" && can(regex("^[0-9]{12}$", var.sandbox_account_id)) && terraform.workspace == "default"
    )
    error_message = "Bootstrap requires the reviewed sandbox account, us-east-1, sandbox and the default workspace."
  }
}
variable "enable_sandbox_terraform_role" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_sandbox_terraform_role || var.enable_private_evidence_store
    error_message = "The Terraform role requires the private evidence store."
  }
}
variable "environment" {
  type    = string
  default = "sandbox"
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "sandbox_account_id" {
  type    = string
  default = ""
}
variable "kms_key_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:kms:us-east-1:${var.sandbox_account_id}:key/[a-f0-9-]{36}$", var.kms_key_arn))
    error_message = "Supply the exact existing sandbox KMS key ARN."
  }
}
variable "administrator_role_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:iam::${var.sandbox_account_id}:role/[A-Za-z0-9_+=,.@/-]+$", var.administrator_role_arn))
    error_message = "Supply the reviewed same-account administrator role ARN."
  }
}
variable "reviewer_role_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:iam::${var.sandbox_account_id}:role/[A-Za-z0-9_+=,.@/-]+$", var.reviewer_role_arn))
    error_message = "Supply the reviewed same-account private reviewer role ARN."
  }
}
variable "github_repository_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_sandbox_terraform_role || can(regex("^[1-9][0-9]+$", var.github_repository_id))
    error_message = "Supply the independently verified immutable GitHub repository ID."
  }
}
variable "github_owner_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_sandbox_terraform_role || can(regex("^[1-9][0-9]+$", var.github_owner_id))
    error_message = "Supply the independently verified immutable GitHub owner ID."
  }
}
data "aws_caller_identity" "current" {
  count = var.enable_private_evidence_store ? 1 : 0
}
data "aws_kms_key" "existing" {
  count  = var.enable_private_evidence_store ? 1 : 0
  key_id = var.kms_key_arn
}
data "aws_iam_openid_connect_provider" "github" {
  count = var.enable_sandbox_terraform_role ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}
locals {
  account_root        = "arn:aws:iam::${var.sandbox_account_id}:root"
  bucket_name         = "meeting-notes-sandbox-private-evidence-${var.sandbox_account_id}"
  bucket_arn          = "arn:aws:s3:::${local.bucket_name}"
  capture_objects     = "${local.bucket_arn}/terraform/sandbox/*"
  terraform_role_name = "meeting-notes-sandbox-github-terraform"
  terraform_role_arn  = "arn:aws:iam::${var.sandbox_account_id}:role/${local.terraform_role_name}"
  app_role_arn        = "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-ecs-task-app-role"
  control_table_arn   = "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-sandbox-DeploymentControlTable"
  state_bucket        = "meeting-notes-terraform-state-bucket"
  state_key           = "meeting-notes-terraform/sandbox/meeting-notes-terraform/state"
  capture_reads = [
    "s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketOwnershipControls", "s3:GetBucketPublicAccessBlock",
    "s3:GetBucketPolicyStatus", "s3:GetBucketPolicy", "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration"
  ]
}
output "bucket_policy" {
  value = var.enable_private_evidence_store ? aws_s3_bucket_policy.private_evidence[0].policy : null
}
output "terraform_role_policy" {
  value = var.enable_sandbox_terraform_role ? aws_iam_role_policy.sandbox_terraform[0].policy : null
}
output "terraform_role_trust_policy" {
  value = var.enable_sandbox_terraform_role ? aws_iam_role.sandbox_terraform[0].assume_role_policy : null
}

variable "trusted_refs" {
  type    = set(string)
  default = []
  validation {
    condition     = !var.enable_sandbox_terraform_role || var.trusted_refs == toset(["refs/heads/codex/sandbox-terraform-capture", "refs/heads/master"])
    error_message = "Trust only the two reviewed Sandbox source refs."
  }
}
locals {
  table_suffixes     = ["AccessLogsTable", "ActiveMeetingTable", "AskConversationTable", "AutoRecordSettingsTable", "ChannelContextTable", "ChatTtsUsageTable", "ConfigOverridesTable", "ContactFeedbackTable", "DeploymentControlTable", "DictionaryTable", "EntitlementGrantTable", "FeedbackTable", "GuildSubscriptionTable", "InstallerTable", "InteractionReceiptTable", "McpOAuthTable", "MeetingControlCommandTable", "MeetingHistoryTable", "MeetingShareTable", "MeetingUserIndexTable", "NotionIntegrationTable", "OnboardingStateTable", "PaymentTransactionTable", "PersonalMediaUploadJobTable", "PersonalRecordingSegmentTable", "RecordingTranscriptTable", "ServerContextTable", "SessionTable", "StripeWebhookEventTable", "UserSpeechSettingsTable"]
  table_arns         = [for suffix in local.table_suffixes : "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-sandbox-${suffix}"]
  runtime_policy_arn = "arn:aws:iam::${var.sandbox_account_id}:policy/meeting-notes-sandbox-bot-dynamodb-policy"
}

output "bucket_name" {
  value = var.enable_private_evidence_store ? aws_s3_bucket.private_evidence[0].bucket : null
}
output "terraform_role_arn" {
  value = var.enable_sandbox_terraform_role ? aws_iam_role.sandbox_terraform[0].arn : null
}

variable "site_frontend_bucket" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_sandbox_terraform_role || (can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.site_frontend_bucket)) && !strcontains(var.site_frontend_bucket, "..") && !can(regex("^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$|^(xn--|sthree-|amzn-s3-demo-)|(-s3alias|--ol-s3|[.]mrap|--x-s3|--table-s3)$", var.site_frontend_bucket)))
    error_message = "Supply the exact existing Sandbox frontend bucket from the deployment selectors."
  }
}
variable "site_docs_bucket" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_sandbox_terraform_role || (can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.site_docs_bucket)) && !strcontains(var.site_docs_bucket, "..") && !can(regex("^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$|^(xn--|sthree-|amzn-s3-demo-)|(-s3alias|--ol-s3|[.]mrap|--x-s3|--table-s3)$", var.site_docs_bucket)))
    error_message = "Supply the exact existing Sandbox docs bucket from the deployment selectors."
  }
}
