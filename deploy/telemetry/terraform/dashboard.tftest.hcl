mock_provider "signoz" {}

run "dashboard_contract" {
  command = apply
  variables {
    alert_channels = ["telemetry-test"]
  }
  assert {
    condition     = signoz_dashboard.hindsight.name == "hindsight-health-7haadkeb" && signoz_dashboard.hindsight.schema_version == "v6"
    error_message = "Keep the existing dashboard identity and V2 schema."
  }
  assert {
    condition     = length(signoz_dashboard.hindsight.spec.panels) == length(local.panels)
    error_message = "Render every catalog panel."
  }
  assert {
    condition = alltrue([for id, panel in local.panels : (
      signoz_dashboard.hindsight.spec.panels[id].spec.display.name == panel.spec.display.name &&
      signoz_dashboard.hindsight.spec.panels[id].spec.queries[0].spec.name == panel.spec.queries[0].spec.name
    )])
    error_message = "Preserve panel names and query references."
  }
  assert {
    condition = alltrue([for key, query in local.builders : (
      strcontains(query.filter.expression, "hindsight-") &&
      length(query.aggregations) > 0 && query.step_interval == "60"
    )])
    error_message = "Queries must remain scoped, aggregated, and bounded."
  }
  assert {
    condition = alltrue(flatten([for layout in signoz_dashboard.hindsight.spec.layouts : [
      for item in layout.grid.spec.items : contains(keys(local.panels), trimprefix(item.content.ref, "#/spec/panels/")) && item.x + item.width <= 12
    ]]))
    error_message = "Layout references must select catalog panels and fit the grid."
  }
  assert {
    condition = alltrue([for service, rule in signoz_rule.telemetry_missing : (
      rule.condition.alert_on_absent && rule.condition.absent_for == 3 &&
      strcontains(rule.condition.composite_query.queries[0].builder_query.spec.metrics.filter.expression, service) &&
      strcontains(rule.condition.composite_query.queries[0].builder_query.spec.metrics.filter.expression, "production")
    )]) && length(signoz_rule.telemetry_missing) == 2
    error_message = "Missing-data rules must cover only the two always-on production services."
  }
}

run "no_notification_channel" {
  command = plan
  variables {
    alert_channels = []
  }
  assert {
    condition     = length(signoz_rule.telemetry_missing) == 0
    error_message = "Do not create rules without a real notification channel."
  }
}
