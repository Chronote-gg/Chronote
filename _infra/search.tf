# Disabled until the saved-plan approval, text configuration and backfill gates pass.
variable "ENABLE_MEETING_SEARCH" {
  type    = bool
  default = false
  validation {
    condition     = !var.ENABLE_MEETING_SEARCH || var.aws_region == "us-east-1"
    error_message = "Meeting search is qualified only in us-east-1."
  }
}

variable "ENABLE_SEARCH_PROJECTION" {
  type    = bool
  default = false
  validation {
    condition     = !var.ENABLE_SEARCH_PROJECTION || var.ENABLE_MEETING_SEARCH
    error_message = "Provision and configure search indexes before enabling projection."
  }
}

variable "SEARCH_ENABLED" {
  description = "Serve derived search only after configuration and backfill acceptance."
  type        = bool
  default     = false
  validation {
    condition     = !var.SEARCH_ENABLED || var.ENABLE_MEETING_SEARCH
    error_message = "Search serving requires provisioned indexes."
  }
}

variable "ASK_AGENT_ENABLED" {
  type    = bool
  default = false
  validation {
    condition     = !var.ASK_AGENT_ENABLED || var.SEARCH_ENABLED
    error_message = "Ask agent requires accepted search serving."
  }
}

variable "SEARCH_GENERATION" {
  type    = string
  default = "g1"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.SEARCH_GENERATION))
    error_message = "Search generation must be a lowercase index-name suffix."
  }
}

variable "SEARCH_RETAINED_GENERATIONS" {
  description = "Retain previous indexes for rollback when selecting a new generation."
  type        = set(string)
  default     = ["g1"]
  validation {
    condition     = alltrue([for generation in var.SEARCH_RETAINED_GENERATIONS : can(regex("^[a-z0-9][a-z0-9-]{0,31}$", generation))])
    error_message = "Retained generations must be lowercase index-name suffixes."
  }
}

locals {
  search_bucket_arn  = "arn:aws:s3vectors:${var.aws_region}:${data.aws_caller_identity.current.account_id}:bucket/${local.name_prefix}-search-${data.aws_caller_identity.current.account_id}"
  search_index_arns  = [for name in sort(tolist(local.search_indexes)) : "${local.search_bucket_arn}/index/${name}"]
  search_state_arn   = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name_prefix}-MeetingSearchState"
  search_source_arn  = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name_prefix}-MeetingHistoryTable"
  search_failure_arn = "arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.name_prefix}-search-failures"
  search_log_arn     = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name_prefix}-search-projection"
  search_indexes     = var.ENABLE_MEETING_SEARCH ? toset(flatten([for generation in setunion(var.SEARCH_RETAINED_GENERATIONS, [var.SEARCH_GENERATION]) : ["meetings-${generation}", "transcripts-${generation}"]])) : toset([])
  search_runtime_environment = concat([
    { name = "SEARCH_ENABLED", value = tostring(var.SEARCH_ENABLED) },
    { name = "ASK_AGENT_ENABLED", value = tostring(var.ASK_AGENT_ENABLED) }
    ], var.ENABLE_MEETING_SEARCH ? [
    { name = "SEARCH_MEETING_INDEX_ARN", value = aws_s3vectors_index.search["meetings-${var.SEARCH_GENERATION}"].index_arn },
    { name = "SEARCH_TRANSCRIPT_INDEX_ARN", value = aws_s3vectors_index.search["transcripts-${var.SEARCH_GENERATION}"].index_arn },
    { name = "SEARCH_STATE_TABLE_NAME", value = aws_dynamodb_table.meeting_search_state[0].name },
    { name = "SEARCH_GENERATION", value = var.SEARCH_GENERATION }
  ] : [])
}

resource "aws_s3vectors_vector_bucket" "search" {
  count              = var.ENABLE_MEETING_SEARCH ? 1 : 0
  vector_bucket_name = "${local.name_prefix}-search-${data.aws_caller_identity.current.account_id}"
  force_destroy      = false
  encryption_configuration = [{
    sse_type    = "AES256"
    kms_key_arn = null
  }]
  lifecycle { prevent_destroy = true }
}

# Provider 6.71.0 lacks ENHANCED/text fields. configure-s3-search.ts owns only those fields.
resource "aws_s3vectors_index" "search" {
  for_each           = local.search_indexes
  vector_bucket_name = aws_s3vectors_vector_bucket.search[0].vector_bucket_name
  index_name         = each.key
  data_type          = "float32"
  dimension          = 1536
  distance_metric    = "cosine"
  metadata_configuration { non_filterable_metadata_keys = ["search_text"] }
  lifecycle { prevent_destroy = true }
}

resource "aws_dynamodb_table" "meeting_search_state" {
  count        = var.ENABLE_MEETING_SEARCH ? 1 : 0
  name         = "${local.name_prefix}-MeetingSearchState"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "projectionId"
  attribute {
    name = "projectionId"
    type = "S"
  }
  attribute {
    name = "projectionRef"
    type = "S"
  }
  global_secondary_index {
    name            = "ProjectionMeetingIndex"
    hash_key        = "projectionRef"
    range_key       = "projectionId"
    projection_type = "ALL"
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }
  lifecycle { prevent_destroy = true }
}

# Serving processes can query and read coverage, but cannot mutate the derived index.
resource "aws_iam_role_policy" "search_reader" {
  count = var.ENABLE_MEETING_SEARCH ? 1 : 0
  name  = "${local.name_prefix}-search-reader"
  role  = aws_iam_role.ecs_task_app_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3vectors:GetIndex", "s3vectors:QueryVectors", "s3vectors:GetVectors"], Resource = local.search_index_arns },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem"], Resource = local.search_state_arn }
    ]
  })
}

resource "aws_sqs_queue" "search_failures" {
  count                     = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  name                      = "${local.name_prefix}-search-failures"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.app_general.arn
}

resource "aws_iam_role" "search_projection" {
  count = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  name  = "${local.name_prefix}-search-projection"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_cloudwatch_log_group" "search_projection" {
  count             = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-search-projection"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app_general.arn
}

resource "aws_iam_role_policy" "search_projection" {
  count      = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  name       = "${local.name_prefix}-search-projection"
  role       = "${local.name_prefix}-search-projection"
  depends_on = [aws_iam_role.search_projection]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], Resource = "${local.search_source_arn}/stream/*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Scan"], Resource = local.search_source_arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query"], Resource = [local.search_state_arn, "${local.search_state_arn}/index/ProjectionMeetingIndex"] },
      { Effect = "Allow", Action = ["s3vectors:GetIndex", "s3vectors:PutVectors", "s3vectors:DeleteVectors", "s3vectors:GetVectors", "s3vectors:ListVectors"], Resource = local.search_index_arns },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.transcripts.arn}/*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.openai_api_key.arn, aws_secretsmanager_secret.langfuse_public_key.arn, aws_secretsmanager_secret.langfuse_secret_key.arn] },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.app_general.arn },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = local.search_failure_arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${local.search_log_arn}:*" }
    ]
  })
}

data "archive_file" "search_projection" {
  count       = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../build/search-projection"
  output_path = "${path.module}/search_projection.zip"
}

resource "aws_lambda_function" "search_projection" {
  count                          = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  function_name                  = "${local.name_prefix}-search-projection"
  role                           = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name_prefix}-search-projection"
  runtime                        = "nodejs24.x"
  handler                        = "main.handler"
  filename                       = data.archive_file.search_projection[0].output_path
  source_code_hash               = data.archive_file.search_projection[0].output_base64sha256
  timeout                        = 300
  memory_size                    = 1024
  reserved_concurrent_executions = 2
  environment {
    variables = {
      NODE_ENV                       = "production"
      RUNTIME_ROLE                   = "search-projection"
      DDB_TABLE_PREFIX               = "${local.name_prefix}-"
      SEARCH_HISTORY_TABLE_NAME      = aws_dynamodb_table.meeting_history_table.name
      TRANSCRIPTS_BUCKET             = local.transcripts_bucket_name
      TRANSCRIPTS_PREFIX             = var.TRANSCRIPTS_PREFIX
      SEARCH_STATE_TABLE_NAME        = "${local.name_prefix}-MeetingSearchState"
      SEARCH_GENERATION              = var.SEARCH_GENERATION
      SEARCH_MEETING_INDEX_ARN       = "${local.search_bucket_arn}/index/meetings-${var.SEARCH_GENERATION}"
      SEARCH_TRANSCRIPT_INDEX_ARN    = "${local.search_bucket_arn}/index/transcripts-${var.SEARCH_GENERATION}"
      OPENAI_API_KEY_SECRET_ARN      = aws_secretsmanager_secret.openai_api_key.arn
      LANGFUSE_PUBLIC_KEY_SECRET_ARN = aws_secretsmanager_secret.langfuse_public_key.arn
      LANGFUSE_SECRET_KEY_SECRET_ARN = aws_secretsmanager_secret.langfuse_secret_key.arn
      LANGFUSE_BASE_URL              = var.LANGFUSE_BASE_URL
      LANGFUSE_TRACING_ENVIRONMENT   = var.environment == "prod" ? "production" : var.environment
      LANGFUSE_RELEASE               = "search-${var.SEARCH_GENERATION}"
    }
  }
  dead_letter_config { target_arn = local.search_failure_arn }
  depends_on = [aws_iam_role_policy.search_projection, aws_cloudwatch_log_group.search_projection, aws_sqs_queue.search_failures]
}

resource "aws_lambda_event_source_mapping" "meeting_search" {
  count                              = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  event_source_arn                   = aws_dynamodb_table.meeting_history_table.stream_arn
  function_name                      = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.name_prefix}-search-projection"
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
  bisect_batch_on_function_error     = true
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 21600
  destination_config {
    on_failure { destination_arn = local.search_failure_arn }
  }
  depends_on = [aws_iam_role_policy.search_projection, aws_lambda_function.search_projection, aws_sqs_queue.search_failures]
}

# Full canonical reconciliation, including deleted-state cleanup, survives stream retention.
resource "aws_cloudwatch_event_rule" "search_reconcile" {
  count               = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  name                = "${local.name_prefix}-search-reconcile"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "search_reconcile" {
  count = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  rule  = aws_cloudwatch_event_rule.search_reconcile[0].name
  arn   = aws_lambda_function.search_projection[0].arn
  input = jsonencode({ reconcile = true })
}

resource "aws_lambda_permission" "search_reconcile" {
  count         = var.ENABLE_SEARCH_PROJECTION ? 1 : 0
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.search_projection[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.search_reconcile[0].arn
}

output "search_index_arns" {
  value = { for name, index in aws_s3vectors_index.search : name => index.index_arn }
}
