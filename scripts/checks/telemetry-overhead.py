"""Measure Python SDK hot-path overhead without provider calls or network export."""
import importlib.util
import json
import os
from pathlib import Path
import resource
import sys
import time

os.environ["HINDSIGHT_OTEL_ADAPTER_ENABLED"] = "0"
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:1"
enabled = sys.argv[1] == "enabled"
os.environ["OTEL_SDK_DISABLED"] = "false" if enabled else "true"
if enabled:
    spec = importlib.util.spec_from_file_location("measured_telemetry", Path(__file__).parents[2] / "deploy/telemetry/sitecustomize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.initialize()

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, MetricExportResult
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

class DiscardExporter(SpanExporter):
    def export(self, spans):
        return SpanExportResult.SUCCESS
    def shutdown(self):
        pass

OTLPMetricExporter.export = lambda *args, **kwargs: MetricExportResult.SUCCESS
traces = TracerProvider()
traces.add_span_processor(BatchSpanProcessor(DiscardExporter()))
tracer = traces.get_tracer("hindsight-overhead-test")
metrics = MeterProvider(metric_readers=[InMemoryMetricReader()])
meter = metrics.get_meter("hindsight-overhead-test")
counter = meter.create_counter("check.operations")
histogram = meter.create_histogram("check.duration")
count = 10_000
cpu = time.process_time()
start = time.perf_counter()
for _ in range(count):
    with tracer.start_as_current_span("hindsight.check", attributes={"hindsight.operation": "recall"}) as span:
        span.set_attribute("gen_ai.usage.input_tokens", 7)
        counter.add(1, {"scope": "recall"})
        histogram.record(0.01, {"scope": "recall"})
wall_ms = (time.perf_counter() - start) * 1000
cpu_ms = (time.process_time() - cpu) * 1000
print(json.dumps({"mode": "enabled" if enabled else "disabled", "operations": count, "wallMs": wall_ms, "cpuMs": cpu_ms, "peakRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}))
traces.shutdown()
metrics.shutdown()
