resource "signoz_rule" "telemetry_missing" {
  for_each       = toset(["hindsight-importer", "hindsight-api"])
  alert          = "${each.value}: telemetry missing"
  alert_type     = "METRIC_BASED_ALERT"
  rule_type      = "threshold_rule"
  schema_version = "v2alpha1"
  description    = "No production telemetry heartbeat: a two-minute window has been empty for three minutes. Check the service and collector."
  labels         = { service = each.value, severity = "warning" }
  condition = {
    alert_on_absent     = true
    absent_for          = 3
    selected_query_name = "A"
    composite_query = {
      panel_type = "graph"
      query_type = "builder"
      unit       = "s"
      queries = [{
        builder_query = {
          type = "builder_query"
          spec = {
            metrics = {
              name          = "A"
              signal        = "metrics"
              step_interval = "60"
              aggregations = [{
                metric_name       = "hindsight.telemetry.heartbeat"
                time_aggregation  = "max"
                space_aggregation = "max"
                reduce_to         = "last"
              }]
              filter = { expression = "service.name = '${each.value}' AND deployment.environment.name = 'production'" }
            }
          }
        }
      }]
    }
    thresholds = {
      basic = {
        kind = "basic"
        spec = [{ name = "warning", op = "below", target = 1, match_type = "at_least_once", channels = [] }]
      }
    }
  }
  evaluation            = { rolling = { kind = "rolling", spec = { eval_window = "2m", frequency = "1m" } } }
  notification_settings = {}
}
