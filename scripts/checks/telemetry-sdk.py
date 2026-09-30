"""Check the safety adapter against the pinned Hindsight OpenTelemetry SDK."""
import importlib.util
import json
import os
from pathlib import Path
import sys

os.environ["HINDSIGHT_OTEL_ADAPTER_ENABLED"] = "0"
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:1"
shim = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "deploy/telemetry/sitecustomize.py"
spec = importlib.util.spec_from_file_location("checked_telemetry", shim)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.initialize()

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode, Link, SpanContext, TraceFlags
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, MetricExportResult
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.metrics import Observation

OTLPMetricExporter.export = lambda *args, **kwargs: MetricExportResult.SUCCESS

exporter = InMemorySpanExporter()
provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(exporter))
tracer = provider.get_tracer("safety-check")
link = Link(SpanContext(1, 1, False, TraceFlags(1)), {"private": "CANARY"})
with tracer.start_as_current_span("hindsight.check", attributes={"gen_ai.input.messages": "CANARY", "gen_ai.usage.input_tokens": 7}, links=[link]) as parent:
    assert "CANARY" not in str(parent.attributes)
    assert not parent.links
    with tracer.start_as_current_span("chat CANARY") as child:
        child.set_attribute("gen_ai.output.messages", "CANARY")
        child.set_attributes({"password": "CANARY", "http.response.status_code": 200})
        child.update_name("chat CANARY")
        child.add_event("CANARY", {"content": "CANARY"})
        child.record_exception(RuntimeError("CANARY"))
        child.set_status(Status(StatusCode.ERROR, "CANARY"))
        assert "CANARY" not in str(child.attributes)
        assert "CANARY" not in child.name
        assert not child.events
        assert child.status.description is None
        assert child.status.status_code == StatusCode.ERROR
spans = exporter.get_finished_spans()
assert len(spans) == 2
assert spans[0].parent.span_id == spans[1].context.span_id
assert spans[0].context.trace_id == spans[1].context.trace_id
assert spans[1].attributes["gen_ai.usage.input_tokens"] == 7

reader = InMemoryMetricReader()
metrics = MeterProvider(metric_readers=[reader])
meter = metrics.get_meter("safety-check")
meter.create_counter("check.counter").add(42, {"bank_id": "CANARY", "scope": "retain"})
meter.create_histogram("check.histogram").record(2, {"tenant": "CANARY", "scope": "retain"})
meter.create_observable_gauge("check.observable", callbacks=[lambda _: [Observation(3, {"password": "CANARY", "scope": "retain"})]])
data = reader.get_metrics_data()
assert "CANARY" not in str(data)
points = {metric.name: metric.data.data_points[0] for resource in data.resource_metrics for scope in resource.scope_metrics for metric in scope.metrics if metric.name.startswith("check.")}
assert points["check.counter"].value == 42
assert points["check.histogram"].sum == 2
assert points["check.observable"].value == 3
assert all(point.attributes == {"scope": "retain"} for point in points.values())
metrics.shutdown()
provider.shutdown()
print(json.dumps({"sdkAdmissionSafe": True, "parentChildPreserved": True, "numericMetricsPreserved": True}))
