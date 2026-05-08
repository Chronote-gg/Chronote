terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      version = "~> 6.27"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# Create S3 bucket for storing Terraform state
resource "aws_s3_bucket" "terraform_state" {
  bucket = "meeting-notes-terraform-state-bucket"

  tags = {
    Name = "Terraform State Bucket"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_kms_key" "terraform_state" {
  description             = "KMS key for Terraform state bucket encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "Terraform State KMS Key"
  }
}

resource "aws_kms_alias" "terraform_state" {
  name          = "alias/meeting-notes-terraform-state"
  target_key_id = aws_kms_key.terraform_state.key_id
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "terraform_state" {
  depends_on = [aws_s3_bucket_ownership_controls.terraform_state]
  bucket = aws_s3_bucket.terraform_state.id
  acl = "private"
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Optionally, create a DynamoDB table for state locking
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "meeting-notes-terraform-state-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name = "Terraform State Lock Table"
  }
}
