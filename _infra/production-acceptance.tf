# Source declarations only. Both the parent authority and this collector stay disabled by default.
variable "enable_production_acceptance_collector" {
  type    = bool
  default = false
}
variable "production_acceptance_fixtures" {
  type    = list(object({ guild_id = string, voice_channel_id = string, meeting_id = string }))
  default = []
  validation {
    condition = length(var.production_acceptance_fixtures) == 0 || (length(var.production_acceptance_fixtures) == 2 && alltrue(flatten([
      for fixture in var.production_acceptance_fixtures : [for value in [fixture.guild_id, fixture.voice_channel_id, fixture.meeting_id] : can(regex("^[A-Za-z0-9][A-Za-z0-9_-]*$", value))]
    ])))
    error_message = "Declare exactly the two approved fixture identities without wildcard or path components."
  }
}
locals {
  production_acceptance_enabled = local.production_introduction_enabled && var.enable_production_acceptance_collector
  production_acceptance_folders = [for fixture in var.production_acceptance_fixtures : "${aws_s3_bucket.transcripts.arn}/${replace(var.TRANSCRIPTS_PREFIX, "/\\/?$/", "/")}${fixture.guild_id}/${fixture.voice_channel_id}_${fixture.meeting_id}_????-??-??T??-??-??.???Z/"]
  production_acceptance_attempt = "checkpoints/v1/1-????????-????-4???-????-????????????/"
  production_acceptance_objects = flatten([for folder in local.production_acceptance_folders : [
    "${folder}transcript.json",
    "${folder}${local.production_acceptance_attempt}manifests/*",
    "${folder}${local.production_acceptance_attempt}audio/*"
  ]])
  production_acceptance_excluded_objects = flatten([for folder in local.production_acceptance_folders : [
    "${folder}checkpoints/v1/*/context/*", "${folder}checkpoints/v1/*/transcription/*"
  ]])
  # DynamoDB LeadingKeys restricts the guild partition, not the history sort key. The authenticated reader enforces the consumed grant key.
  production_acceptance_history_attributes = ["guildId", "channelId_timestamp", "meetingId", "channelId", "textChannelId", "ownerInstanceId", "executionVersion", "status", "transcribeMeeting", "generateNotes", "fixtureInput", "fixtureGeneration", "fixtureTranscript", "checkpoint", "capture", "recovery", "notesVersion", "notesChannelId", "notesMessageIds", "summaryMessageId", "transcriptS3Key", "notesDeliveryTiming", "processing", "delivery", "notes"]
}
resource "aws_iam_role" "production_acceptance_collector" {
  count                = local.production_acceptance_enabled ? 1 : 0
  name                 = "${local.name_prefix}-acceptance-collector"
  max_session_duration = 3600
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Effect = "Allow", Principal = { Federated = data.aws_iam_openid_connect_provider.production_introduction[0].arn }, Action = "sts:AssumeRoleWithWebIdentity",
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:ref:refs/heads/master"
        "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
        "token.actions.githubusercontent.com:workflow"            = "Production introduction"
        "token.actions.githubusercontent.com:repository_id"       = tostring(data.github_repository.repo.repo_id)
        "token.actions.githubusercontent.com:repository_owner_id" = data.github_organization.production_introduction_owner[0].id
      }, StringLike = { "sts:RoleSessionName" = "introduction-read-*-1" } }
    },
    {
      Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "sts:AssumeRole",
      Condition = {
        ArnEquals  = { "aws:PrincipalArn" = [aws_iam_role.production_introduction["introduction"].arn, "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name_prefix}-acceptance-collector"] }
        StringLike = { "sts:RoleSessionName" = ["introduction-content-*-1-0", "introduction-content-*-1-1"] }
      }
    }
  ] })
  lifecycle {
    precondition {
      condition     = length(var.production_acceptance_fixtures) == 2 && length(distinct([for fixture in var.production_acceptance_fixtures : "${fixture.guild_id}/${fixture.voice_channel_id}/${fixture.meeting_id}"])) == 2 && can(regex("^([A-Za-z0-9][A-Za-z0-9_-]*/)+$", var.TRANSCRIPTS_PREFIX))
      error_message = "Acceptance requires two distinct exact fixtures and a safe nonempty approved storage prefix."
    }
  }
}
resource "aws_iam_role_policy" "production_acceptance_collector" {
  count = local.production_acceptance_enabled ? 1 : 0
  role  = aws_iam_role.production_acceptance_collector[0].id
  name  = "bounded-fixture-collection"
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    for statement in jsondecode(aws_iam_role_policy.production_introduction[0].policy).Statement : statement if contains(["BoundService", "TaskMetadata", "RegionalDefinitionMetadata", "ClusterInventory", "ServiceRevisionMetadata", "TopologyMetadata", "SourceImageMetadata", "LauncherMetadata"], statement.Sid)
    ], [
    { Sid = "ReadOriginalControl", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = aws_dynamodb_table.deployment_control_table.arn, Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["ENV", "INTRODUCTION#*", "FIXTURE#*"] } } },
    { Sid = "ExactFixtureGuildHistory", Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = aws_dynamodb_table.meeting_history_table.arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = distinct([for fixture in var.production_acceptance_fixtures : fixture.guild_id]), "dynamodb:Attributes" = local.production_acceptance_history_attributes }, Null = { "dynamodb:Attributes" = "false" } } },
    { Sid = "ReadControlHistoryKeys", Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com", "kms:CallerAccount" = data.aws_caller_identity.current.account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = [aws_dynamodb_table.deployment_control_table.name, aws_dynamodb_table.meeting_history_table.name] } } },
    { Sid = "GeneratedFixtureObjects", Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = local.production_acceptance_objects },
    { Sid = "NoCheckpointTextInputs", Effect = "Deny", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = local.production_acceptance_excluded_objects },
    { Sid = "GeneratedFixtureKey", Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com", "kms:CallerAccount" = data.aws_caller_identity.current.account_id }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = local.production_acceptance_objects } } },
    { Sid = "NoCheckpointTextKey", Effect = "Deny", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringLike = { "kms:EncryptionContext:aws:s3:arn" = local.production_acceptance_excluded_objects } } },
    { Sid = "NarrowFixtureSessions", Effect = "Allow", Action = ["sts:AssumeRole"], Resource = aws_iam_role.production_acceptance_collector[0].arn, Condition = { StringLike = { "sts:RoleSessionName" = ["introduction-content-*-1-0", "introduction-content-*-1-1"] } } }
  ]) })
}
resource "aws_iam_role_policy" "production_introduction_fixture_reads" {
  count = local.production_acceptance_enabled ? 1 : 0
  role  = aws_iam_role.production_introduction["introduction"].id
  name  = "bounded-fixture-final-collection"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    for statement in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement : statement if contains(["ExactFixtureGuildHistory", "ReadControlHistoryKeys", "NarrowFixtureSessions"], statement.Sid)
  ] })
}
output "production_acceptance_collector_role_arn" {
  value = local.production_acceptance_enabled ? aws_iam_role.production_acceptance_collector[0].arn : ""
}
