mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:role/Administrator" } }
  mock_data "aws_kms_key" { defaults = { aws_account_id = "123456789012", arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", key_state = "Enabled" } }
  mock_data "aws_iam_openid_connect_provider" { defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com", url = "token.actions.githubusercontent.com", client_id_list = ["sts.amazonaws.com"] } }
}
variables {
  sandbox_account_id     = "123456789012"
  kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111"
  administrator_role_arn = "arn:aws:iam::123456789012:role/Administrator"
  reviewer_role_arn      = "arn:aws:iam::123456789012:role/PrivateReader"
  trusted_refs           = ["refs/heads/codex/sandbox-terraform-capture", "refs/heads/master"]
  github_repository_id   = "123456"
  github_owner_id        = "654321"
}
run "enabled" {
  command = plan
  variables {
    enable_private_evidence_store = true
    enable_sandbox_terraform_role = true
  }
}
