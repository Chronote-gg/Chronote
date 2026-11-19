# Keep the provider address and removed blocks until every workspace has applied retirement.
provider "grafana" {
  alias = "amg"
  url   = "http://localhost"
}

# Workspace deletion removes these objects. Forget their state here so
# Terraform does not call the Grafana API while AWS deletes the workspace.
removed {
  from = grafana_dashboard.starter

  lifecycle {
    destroy = false
  }
}

removed {
  from = grafana_folder.observability

  lifecycle {
    destroy = false
  }
}

removed {
  from = grafana_data_source.amp

  lifecycle {
    destroy = false
  }
}
