terraform {
  required_version = "= 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.27"
    }
  }
  backend "s3" {
    region               = "us-east-1"
    bucket               = "meeting-notes-terraform-state-bucket"
    key                  = "meeting-notes-terraform/production-bootstrap/state"
    dynamodb_table       = "meeting-notes-terraform-state-locks"
    workspace_key_prefix = "meeting-notes-terraform/production-bootstrap/workspaces"
    encrypt              = true
  }
}
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = var.enable_private_evidence_store ? [var.production_account_id] : null
  default_tags {
    tags = { Project = "meeting-notes", Environment = "prod", ManagedBy = "terraform", Service = "chronote" }
  }
}
variable "enable_private_evidence_store" {
  type    = bool
  default = false
  validation {
    condition = !var.enable_private_evidence_store || (
      var.environment == "prod" && var.aws_region == "us-east-1" && can(regex("^[0-9]{12}$", var.production_account_id)) && terraform.workspace == "default"
    )
    error_message = "Bootstrap requires the reviewed production account, us-east-1, prod and the default workspace."
  }
}
variable "enable_production_terraform_role" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_production_terraform_role || var.enable_private_evidence_store
    error_message = "The Terraform role requires the private evidence store."
  }
}
variable "environment" {
  type    = string
  default = "prod"
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "production_account_id" {
  type    = string
  default = ""
}
variable "kms_key_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:kms:us-east-1:${var.production_account_id}:key/[a-f0-9-]{36}$", var.kms_key_arn))
    error_message = "Supply the exact existing production KMS key ARN."
  }
}
variable "administrator_role_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:iam::${var.production_account_id}:role/.+$", var.administrator_role_arn))
    error_message = "Supply the reviewed same-account administrator role ARN."
  }
}
variable "reviewer_role_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_private_evidence_store || can(regex("^arn:aws:iam::${var.production_account_id}:role/.+$", var.reviewer_role_arn))
    error_message = "Supply the reviewed same-account private reviewer role ARN."
  }
}
variable "github_repository_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_production_terraform_role || can(regex("^[1-9][0-9]+$", var.github_repository_id))
    error_message = "Supply the independently verified immutable GitHub repository ID."
  }
}
variable "github_owner_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_production_terraform_role || can(regex("^[1-9][0-9]+$", var.github_owner_id))
    error_message = "Supply the independently verified immutable GitHub owner ID."
  }
}
variable "production_certificate_arn" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_production_terraform_role || can(regex("^arn:aws:acm:us-east-1:${var.production_account_id}:certificate/[a-f0-9-]{36}$", var.production_certificate_arn))
    error_message = "Supply the exact production API certificate ARN."
  }
}
variable "production_hosted_zone_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_production_terraform_role || can(regex("^Z[A-Z0-9]+$", var.production_hosted_zone_id))
    error_message = "Supply the exact production hosted zone ID."
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
  count = var.enable_production_terraform_role ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}
locals {
  account_root        = "arn:aws:iam::${var.production_account_id}:root"
  bucket_name         = "meeting-notes-prod-private-evidence-${var.production_account_id}"
  bucket_arn          = "arn:aws:s3:::${local.bucket_name}"
  capture_objects     = "${local.bucket_arn}/terraform/production/*"
  terraform_role_name = "meeting-notes-prod-github-terraform"
  terraform_role_arn  = "arn:aws:iam::${var.production_account_id}:role/${local.terraform_role_name}"
  app_role_arn        = "arn:aws:iam::${var.production_account_id}:role/meeting-notes-prod-ecs-task-app-role"
  control_table_arn   = "arn:aws:dynamodb:us-east-1:${var.production_account_id}:table/meeting-notes-prod-DeploymentControlTable"
  state_bucket        = "meeting-notes-terraform-state-bucket"
  state_key           = "meeting-notes-terraform/state"
  capture_reads = [
    "s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketOwnershipControls", "s3:GetBucketPublicAccessBlock",
    "s3:GetBucketPolicyStatus", "s3:GetBucketPolicy", "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration"
  ]
}
output "bucket_policy" {
  value = var.enable_private_evidence_store ? aws_s3_bucket_policy.private_evidence[0].policy : null
}
output "terraform_role_policy" {
  value = var.enable_production_terraform_role ? aws_iam_role_policy.production_terraform[0].policy : null
}
output "terraform_role_trust_policy" {
  value = var.enable_production_terraform_role ? aws_iam_role.production_terraform[0].assume_role_policy : null
}
