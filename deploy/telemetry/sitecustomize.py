"""Content-safe OTLP export for the pinned Hindsight Python runtime."""
import atexit
from dataclasses import replace
import logging
import math
import os
import re
import socket
import time

STRING_ATTRIBUTES = {
    "http.request.method", "http.method", "gen_ai.operation.name", "gen_ai.provider.name",
    "gen_ai.request.model", "gen_ai.response.model", "hindsight.operation", "hindsight.scope",
    "hindsight.provider.internal", "error.type", "http.scheme", "url.scheme",
}
NUMBER_ATTRIBUTES = {
    "http.response.status_code", "http.status_code", "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens", "gen_ai.usage.cached_tokens", "gen_ai.tool_calls.count",
}


def safe_attributes(attributes):
    result = {}
    for key, value in (attributes or {}).items():
        if key in NUMBER_ATTRIBUTES and isinstance(value, (int, float)) and math.isfinite(value):
            result[key] = value
        elif key in {"http.request.method", "http.method"} and value in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            result[key] = value
        elif key in STRING_ATTRIBUTES - {"http.request.method", "http.method"} and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value):
            result[key] = value
        elif key == "http.route" and isinstance(value, str):
            result[key] = safe_route(value)
    return result


METRIC_ATTRIBUTES = {
    "operation", "operation_type", "provider", "model", "scope", "status", "budget",
    "source", "method", "type", "state", "phase", "outcome", "mode", "result", "signal",
}


def safe_metric_attributes(attributes):
    result = safe_attributes(attributes)
    for key, value in (attributes or {}).items():
        if key == "method" and value in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            result[key] = value
        elif key in METRIC_ATTRIBUTES - {"method"} and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value):
            result[key] = value
        elif key in {"http.target", "endpoint", "route"} and isinstance(value, str):
            result[key] = safe_route(value)
        elif key == "success" and value in ("true", "false"):
            result[key] = value
        elif key == "token_bucket" and value in ("0-100", "100-500", "500-1k", "1k-5k", "5k-10k", "10k-50k", "50k+"):
            result[key] = value
        elif key == "status_code" and isinstance(value, str) and re.fullmatch(r"[1-5][0-9]{2}", value):
            result[key] = value
        elif key == "status_class" and value in ("1xx", "2xx", "3xx", "4xx", "5xx"):
            result[key] = value
        elif key == "max_tokens" and isinstance(value, str) and re.fullmatch(r"[0-9]{1,6}", value):
            result[key] = value
    return result


def safe_metrics(metrics_data, resource):
    resources = []
    for item in metrics_data.resource_metrics:
        scopes = []
        for scope in item.scope_metrics:
            metrics = []
            for metric in scope.metrics:
                points = [replace(point, attributes=safe_metric_attributes(point.attributes), exemplars=[]) for point in metric.data.data_points]
                metrics.append(replace(metric, data=replace(metric.data, data_points=points)))
            scopes.append(replace(scope, metrics=metrics))
        resources.append(replace(item, resource=resource, scope_metrics=scopes))
    return replace(metrics_data, resource_metrics=resources)


ROUTE_SEGMENTS = {
    "v1", "v2", "default", "banks", "documents", "operations", "mental-models", "entities",
    "memories", "retain", "recall", "reflect", "stats", "config", "profile", "mission",
    "strategies", "observations", "consolidate", "health", "version", "metrics", "dry-run",
    "import", "export", "sync", "tags", "batch", "list", "search", "{id}",
}


def safe_route(route):
    route = route.split("?", 1)[0]
    route = re.sub(r"/(banks|documents|operations|mental-models|entities)/[^/]+", r"/\1/{id}", route)
    if len(route) <= 200 and all(part in ROUTE_SEGMENTS for part in route.split("/") if part):
        return route
    return "/other"


def safe_name(name):
    if name.startswith(("GET ", "POST ", "PUT ", "PATCH ", "DELETE ")):
        method, route = name.split(" ", 1)
        return method + " " + safe_route(route)
    if re.fullmatch(r"hindsight\.[a-z_]+", name):
        return name
    return "hindsight.operation"


def log_event(message):
    # Only classify known operational messages; never forward free-form text.
    lower = message.lower()
    for fragment, event in (
        ("failed", "Hindsight operation failed"), ("error", "Hindsight runtime error"),
        ("consolidat", "Hindsight consolidation event"), ("extract", "Hindsight extraction event"),
        ("completed", "Hindsight operation completed"), ("worker", "Hindsight worker event"),
        ("started", "Hindsight runtime started"), ("shutdown", "Hindsight runtime stopping"),
    ):
        if fragment in lower:
            return event
    return "Hindsight runtime event"


def install_sdk_filters(tracer, span, measurement, status_type):
    original_start = tracer.start_span
    original_set = span.set_attribute
    original_sets = span.set_attributes
    original_name = span.update_name
    original_status = span.set_status
    original_measurement = measurement.__init__

    def start(self, name, context=None, kind=None, attributes=None, links=(), start_time=None, record_exception=True, set_status_on_exception=True):
        options = dict(context=context, attributes=safe_attributes(attributes), links=(), start_time=start_time,
                       record_exception=record_exception, set_status_on_exception=set_status_on_exception)
        if kind is not None:
            options["kind"] = kind
        return original_start(self, safe_name(name), **options)

    def set_attribute(self, key, value):
        for safe_key, safe_value in safe_attributes({key: value}).items():
            original_set(self, safe_key, safe_value)

    def set_attributes(self, attributes):
        return original_sets(self, safe_attributes(attributes))

    def update_name(self, name):
        return original_name(self, safe_name(name))

    def set_status(self, status, description=None):
        return original_status(self, status_type(status.status_code) if hasattr(status, "status_code") else status)

    def measure(self, value, time_unix_nano, instrument, context, attributes=None):
        return original_measurement(self, value, time_unix_nano, instrument, context, safe_metric_attributes(attributes))

    tracer.start_span = start
    span.set_attribute = set_attribute
    span.set_attributes = set_attributes
    span.update_name = update_name
    span.set_status = set_status
    span.add_event = lambda *args, **kwargs: None
    span.record_exception = lambda *args, **kwargs: None
    measurement.__init__ = measure


def initialize():
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import ReadableSpan, Tracer, Span
    from opentelemetry.sdk.metrics._internal.measurement import Measurement
    from opentelemetry.metrics import Observation
    from opentelemetry.trace import Status
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor

    endpoint = os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"].rstrip("/")
    resource = Resource.create({
        "service.name": os.getenv("HINDSIGHT_API_OTEL_SERVICE_NAME", "hindsight-api"),
        "service.version": os.getenv("HINDSIGHT_OTEL_SERVICE_VERSION", "0.9.2"),
        "service.instance.id": f"{socket.gethostname()}:{os.getpid()}",
        "host.name": os.getenv("HINDSIGHT_OTEL_HOST_NAME", socket.gethostname()),
        "deployment.environment.name": "production",
    })
    install_sdk_filters(Tracer, Span, Measurement, Status)
    health = {signal: {"failures": 0, "success_at": None} for signal in ("traces", "metrics", "logs")}

    def observed_export(signal, send, *args, **kwargs):
        try:
            result = send(*args, **kwargs)
            if result.name == "SUCCESS":
                health[signal]["success_at"] = time.time()
            else:
                health[signal]["failures"] += 1
            return result
        except Exception:
            health[signal]["failures"] += 1
            raise

    original_export = OTLPSpanExporter.export

    def export(self, spans):
        cleaned = [ReadableSpan(
            name=safe_name(span.name), context=span.context, parent=span.parent,
            resource=resource, attributes=safe_attributes(span.attributes),
            events=(), links=(), kind=span.kind, status=Status(span.status.status_code),
            start_time=span.start_time, end_time=span.end_time,
            instrumentation_scope=span.instrumentation_scope,
        ) for span in spans]
        return observed_export("traces", original_export, self, cleaned)

    OTLPSpanExporter.export = export
    original_metric_export = OTLPMetricExporter.export

    def export_metrics(self, metrics_data, *args, **kwargs):
        return observed_export("metrics", original_metric_export, self, safe_metrics(metrics_data, resource), *args, **kwargs)

    OTLPMetricExporter.export = export_metrics
    original_metrics_init = MeterProvider.__init__

    def metrics_init(self, *args, **kwargs):
        # Hindsight 0.9.2 uses keyword arguments and a Prometheus reader.
        readers = list(kwargs.get("metric_readers", ()))
        readers.append(PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint + "/v1/metrics", timeout=3),
            export_interval_millis=60_000, export_timeout_millis=3_000,
        ))
        kwargs["metric_readers"] = readers
        kwargs["resource"] = resource
        original_metrics_init(self, *args, **kwargs)
        meter = self.get_meter("pi-hindsight-memory")
        meter.create_observable_gauge("hindsight.telemetry.heartbeat", unit="s", callbacks=[lambda _: [Observation(time.time())]])
        meter.create_observable_counter("hindsight.telemetry.export_failures", callbacks=[lambda _: [Observation(state["failures"], {"signal": signal}) for signal, state in health.items()]])
        meter.create_observable_gauge("hindsight.telemetry.last_success_age", unit="s", callbacks=[lambda _: [Observation(time.time() - state["success_at"], {"signal": signal}) for signal, state in health.items() if state["success_at"] is not None]])

    MeterProvider.__init__ = metrics_init
    original_log_export = OTLPLogExporter.export

    def export_logs(self, records):
        return observed_export("logs", original_log_export, self, records)

    OTLPLogExporter.export = export_logs
    provider = LoggerProvider(resource=resource)
    provider.add_log_record_processor(BatchLogRecordProcessor(
        OTLPLogExporter(endpoint=endpoint + "/v1/logs", timeout=3),
        max_queue_size=2048, export_timeout_millis=3000,
    ))
    delegate = LoggingHandler(level=logging.INFO, logger_provider=provider)

    class SafeHandler(logging.Handler):
        def emit(self, record):
            try:
                # A new record also removes exceptions, stacks, and arbitrary extras.
                cleaned = logging.LogRecord("hindsight", record.levelno, "", 0, log_event(record.getMessage()), (), None)
                delegate.emit(cleaned)
            except Exception:
                pass

    # The package logger survives root logging reconfiguration during startup.
    logging.getLogger("hindsight_api").addHandler(SafeHandler(level=logging.INFO))
    atexit.register(provider.shutdown)


if os.getenv("OTEL_SDK_DISABLED") == "true":
    os.environ["HINDSIGHT_API_OTEL_TRACES_ENABLED"] = "false"
elif os.getenv("HINDSIGHT_OTEL_ADAPTER_ENABLED") == "1":
    try:
        initialize()
    except Exception:
        # Do not export unsanitized traces if this adapter cannot initialize.
        os.environ["HINDSIGHT_API_OTEL_TRACES_ENABLED"] = "false"
        logging.getLogger(__name__).error("Content-safe Hindsight telemetry could not start")
