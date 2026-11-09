mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
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

run "sandbox_artifact_authority" {
  command = plan
  plan_options {
    target = [aws_iam_policy.transcripts_s3_policy, aws_iam_policy.sandbox_artifact_authority, aws_iam_role_policy_attachment.sandbox_artifact_authority]
  }
  variables {
    environment        = "sandbox"
    github_environment = "sandbox"
  }
  assert {
    condition     = length(aws_iam_policy.sandbox_artifact_authority) == 1 && length(aws_iam_role_policy_attachment.sandbox_artifact_authority) == 1 && aws_iam_policy.sandbox_artifact_authority[0].name == "meeting-notes-sandbox-artifact-authority" && aws_iam_role_policy_attachment.sandbox_artifact_authority[0].role == "meeting-notes-sandbox-github-deploy"
    error_message = "Only the existing Sandbox deployment role may receive the dedicated artifact policy."
  }
  assert {
    condition = jsondecode(aws_iam_policy.sandbox_artifact_authority[0].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid      = "ArtifactAuthorityChecks"
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem"]
        Resource = "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable"
      }]
    }
    error_message = "Artifact authority must contain only the exact Sandbox history condition-check grant."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.transcripts_s3_policy.policy).Statement[0].Action == ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:AbortMultipartUpload", "s3:ListBucket"] && jsondecode(aws_iam_policy.transcripts_s3_policy.policy).Statement[0].Resource == ["arn:aws:s3:::meeting-notes-sandbox-transcripts-123456789012", "arn:aws:s3:::meeting-notes-sandbox-transcripts-123456789012/*"]
    error_message = "The existing transcript policy must retain its exact actions and Sandbox bucket resources."
  }
}

run "production_has_no_sandbox_artifact_authority" {
  command = plan
  plan_options { target = [aws_iam_policy.sandbox_artifact_authority, aws_iam_role_policy_attachment.sandbox_artifact_authority] }
  variables {
    environment        = "prod"
    github_environment = "production"
  }
  assert {
    condition     = length(aws_iam_policy.sandbox_artifact_authority) == 0 && length(aws_iam_role_policy_attachment.sandbox_artifact_authority) == 0
    error_message = "The dedicated Sandbox grant must not create production resources."
  }
}
