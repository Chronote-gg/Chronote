variable "grafana_api_key" {
  description = "Grafana service account token (preferred) or AMG API key for the grafana provider"
  type        = string
  default     = ""
  sensitive   = true
}

variable "grafana_url" {
  description = "Grafana workspace endpoint, e.g., https://g-xxxx.grafana-workspace.us-east-1.amazonaws.com/"
  type        = string
  default     = "http://localhost" # placeholder; set to AMG endpoint for real use
}

variable "aws_region" {
  description = "AWS region for SigV4 when querying AMP"
  type        = string
  default     = "us-east-1"
}

provider "grafana" {
  alias   = "amg"
  url     = var.grafana_url
  auth    = var.grafana_api_key
}

locals {
  grafana_enabled = var.grafana_api_key != "" && var.grafana_url != ""
}

resource "grafana_data_source" "amp" {
  count   = local.grafana_enabled ? 1 : 0
  provider = grafana.amg
  name    = "AMP Prometheus"
  type    = "prometheus"
  url     = aws_prometheus_workspace.amp.prometheus_endpoint
  json_data_encoded = jsonencode({
    httpMethod   = "GET"
    sigV4Auth    = true
    sigV4Region  = var.aws_region
    timeInterval = "15s"
  })
}

resource "grafana_folder" "observability" {
  count    = local.grafana_enabled ? 1 : 0
  provider = grafana.amg
  title    = "Meeting Notes Bot"
}

resource "grafana_dashboard" "starter" {
  count       = local.grafana_enabled ? 1 : 0
  provider    = grafana.amg
  folder      = grafana_folder.observability[0].id
  config_json = templatefile("${path.module}/dashboards/starter.json", {
    datasource_uid = grafana_data_source.amp[0].uid
  })
}
