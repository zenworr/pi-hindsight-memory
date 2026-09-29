"""Content-safe OTLP export for the pinned Hindsight Python runtime."""
import atexit
import logging
import math
import os
import re
import socket

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
        elif key in STRING_ATTRIBUTES and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value):
            result[key] = value
        elif key == "http.route" and isinstance(value, str):
            result[key] = safe_route(value)
    return result


def safe_route(route):
    route = route.split("?", 1)[0]
    route = re.sub(r"/(banks|documents|operations|mental-models|entities)/[^/]+", r"/\1/{id}", route)
    if re.fullmatch(r"[/A-Za-z0-9_{}.-]{1,200}", route):
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


def initialize():
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import ReadableSpan
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
    original_export = OTLPSpanExporter.export

    def export(self, spans):
        cleaned = [ReadableSpan(
            name=safe_name(span.name), context=span.context, parent=span.parent,
            resource=resource, attributes=safe_attributes(span.attributes),
            events=(), links=(), kind=span.kind, status=Status(span.status.status_code),
            start_time=span.start_time, end_time=span.end_time,
            instrumentation_scope=span.instrumentation_scope,
        ) for span in spans]
        return original_export(self, cleaned)

    OTLPSpanExporter.export = export
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

    MeterProvider.__init__ = metrics_init
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


if os.getenv("HINDSIGHT_OTEL_ADAPTER_ENABLED") == "1":
    try:
        initialize()
    except Exception:
        # Do not export unsanitized traces if this adapter cannot initialize.
        os.environ["HINDSIGHT_API_OTEL_TRACES_ENABLED"] = "false"
        logging.getLogger(__name__).error("Content-safe Hindsight telemetry could not start")
