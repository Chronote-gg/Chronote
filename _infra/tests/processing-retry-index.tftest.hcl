mock_provider "aws" { override_during = plan }
mock_provider "github" {}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN      = "mock"
  AWS_TOKEN_KEY     = "mock"
  DISCORD_CLIENT_ID = "mock"
}

run "retry_index_enabled_by_default" {
  command = plan
  plan_options { target = [aws_dynamodb_table.meeting_history_table] }
  assert {
    condition     = tomap({ for a in aws_dynamodb_table.meeting_history_table.attribute : a.name => a.type }) == tomap({ guildId = "S", channelId_timestamp = "S", timestamp = "S", updateDeliveryQueue = "S", updateDeliveryDueAt = "N", processingRetryQueue = "S", processingRetryDueAt = "N" })
    error_message = "Default must preserve exactly all seven key attributes with their types."
  }
  assert {
    condition     = tomap({ for i in aws_dynamodb_table.meeting_history_table.global_secondary_index : i.name => [i.hash_key, i.range_key, i.projection_type] }) == tomap({ GuildTimestampIndex = ["guildId", "timestamp", "ALL"], UpdateDeliveryDueIndex = ["updateDeliveryQueue", "updateDeliveryDueAt", "KEYS_ONLY"], ProcessingRetryDueIndex = ["processingRetryQueue", "processingRetryDueAt", "KEYS_ONLY"] })
    error_message = "Default must preserve exactly guild, delivery and retry index definitions."
  }
}

run "delivery_only_omits_retry_index" {
  command = plan
  plan_options { target = [aws_dynamodb_table.meeting_history_table] }
  variables { ENABLE_PROCESSING_RETRY_INDEX = false }
  assert {
    condition     = tomap({ for a in aws_dynamodb_table.meeting_history_table.attribute : a.name => a.type }) == tomap({ guildId = "S", channelId_timestamp = "S", timestamp = "S", updateDeliveryQueue = "S", updateDeliveryDueAt = "N" })
    error_message = "Disabled must omit only the two retry key attributes."
  }
  assert {
    condition     = tomap({ for i in aws_dynamodb_table.meeting_history_table.global_secondary_index : i.name => [i.hash_key, i.range_key, i.projection_type] }) == tomap({ GuildTimestampIndex = ["guildId", "timestamp", "ALL"], UpdateDeliveryDueIndex = ["updateDeliveryQueue", "updateDeliveryDueAt", "KEYS_ONLY"] })
    error_message = "Disabled must preserve exactly guild and delivery index definitions."
  }
}
