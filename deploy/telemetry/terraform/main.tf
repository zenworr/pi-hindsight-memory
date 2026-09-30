terraform {
  required_version = ">= 1.7.0, < 2.0.0"
  required_providers {
    signoz = {
      source  = "SigNoz/signoz"
      version = "0.1.5"
    }
  }
  backend "local" {}
}

provider "signoz" {
  endpoint = "https://signoz.peko.dev"
}

locals {
  dashboard = jsondecode(file("${path.module}/../hindsight-health.json"))
  panels    = local.dashboard.spec.panels
  builders = merge([
    for id, panel in local.panels : {
      for query in concat(
        [for q in panel.spec.queries : q.spec.plugin.spec if q.spec.plugin.kind == "signoz/BuilderQuery"],
        flatten([for q in panel.spec.queries : [for item in try(q.spec.plugin.spec.queries, []) : item.spec if item.type == "builder_query"]])
        ) : "${id}/${query.name}" => {
        name          = query.name
        signal        = query.signal
        step_interval = tostring(query.stepInterval)
        disabled      = query.disabled
        source        = query.source
        filter        = query.filter
        having        = query.having
        limit         = query.limit
        legend        = query.legend
        functions     = query.functions
        order         = query.order
        aggregations = [for aggregation in query.aggregations : {
          metric_name       = try(aggregation.metricName, null)
          temporality       = try(lower(aggregation.temporality), null)
          time_aggregation  = try(aggregation.timeAggregation, null)
          space_aggregation = try(aggregation.spaceAggregation, null)
          reduce_to         = try(aggregation.reduceTo, null)
          expression        = try(aggregation.expression, null)
        }]
        group_by = [for group in query.groupBy : {
          name            = group.name
          field_context   = group.fieldContext
          field_data_type = group.fieldDataType
        }]
      }
    }
  ]...)
}

resource "signoz_dashboard" "hindsight" {
  name           = "hindsight-health-7haadkeb"
  schema_version = local.dashboard.schemaVersion
  image          = "/assets/Icons/eight-ball"
  tags           = [{ key = "service", value = "hindsight" }]
  spec = {
    display          = local.dashboard.spec.display
    variables        = local.dashboard.spec.variables
    duration         = local.dashboard.spec.duration
    refresh_interval = local.dashboard.spec.refreshInterval
    panels = {
      for id, panel in local.panels : id => {
        kind = panel.kind
        spec = {
          display = panel.spec.display
          plugin = {
            number_panel = panel.spec.plugin.kind == "signoz/NumberPanel" ? {
              kind = panel.spec.plugin.kind
              spec = {
                visualization = { time_preference = panel.spec.plugin.spec.visualization.timePreference }
                formatting = {
                  unit              = panel.spec.plugin.spec.formatting.unit
                  decimal_precision = panel.spec.plugin.spec.formatting.decimalPrecision
                }
                thresholds = panel.spec.plugin.spec.thresholds
              }
            } : null
            time_series_panel = panel.spec.plugin.kind == "signoz/TimeSeriesPanel" ? {
              kind = panel.spec.plugin.kind
              spec = {
                visualization = {
                  time_preference = panel.spec.plugin.spec.visualization.timePreference
                  fill_spans      = panel.spec.plugin.spec.visualization.fillSpans
                }
                formatting = {
                  unit              = panel.spec.plugin.spec.formatting.unit
                  decimal_precision = panel.spec.plugin.spec.formatting.decimalPrecision
                }
                legend = { position = "bottom", mode = "list" }
                axes   = { soft_min = 0, is_log_scale = false }
              }
            } : null
          }
          queries = [for query in panel.spec.queries : {
            kind = query.kind
            spec = {
              name = query.spec.name
              plugin = {
                builder_query = query.spec.plugin.kind == "signoz/BuilderQuery" ? {
                  kind = query.spec.plugin.kind
                  spec = { (query.spec.plugin.spec.signal) = local.builders["${id}/${query.spec.name}"] }
                } : null
                composite_query = query.spec.plugin.kind == "signoz/CompositeQuery" ? {
                  kind = query.spec.plugin.kind
                  spec = {
                    queries = [for item in query.spec.plugin.spec.queries : {
                      builder_query = item.type == "builder_query" ? {
                        type = item.type
                        spec = { (item.spec.signal) = local.builders["${id}/${item.spec.name}"] }
                      } : null
                      builder_formula = item.type == "builder_formula" ? {
                        type = item.type
                        spec = item.spec
                      } : null
                    }]
                  }
                } : null
              }
            }
          }]
        }
      }
    }
    layouts = [for layout in local.dashboard.spec.layouts : {
      grid = {
        kind = layout.kind
        spec = {
          display = layout.spec.display
          items = [for item in layout.spec.items : {
            x       = item.x
            y       = item.y
            width   = item.width
            height  = item.height
            content = { ref = item.content["$ref"] }
          }]
        }
      }
    }]
  }
  lifecycle {
    prevent_destroy = true
  }
}

output "dashboard_url" {
  value = "https://signoz.peko.dev/dashboard/${signoz_dashboard.hindsight.id}"
}
