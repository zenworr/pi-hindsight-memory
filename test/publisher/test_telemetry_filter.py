import importlib.util
from dataclasses import dataclass
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("hindsight_telemetry_filter", Path(__file__).parents[2] / "deploy" / "telemetry" / "sitecustomize.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TelemetryFilterTests(unittest.TestCase):
    def test_prompt_completion_headers_and_paths_are_removed(self):
        attrs = module.safe_attributes({
            "gen_ai.input.messages": "CANARY_PROMPT", "gen_ai.output.messages": "CANARY_RESPONSE",
            "gen_ai.system_instructions": "CANARY_SYSTEM", "tool.arguments": "CANARY_TOOL",
            "http.request.header.authorization": "Bearer CANARY_TOKEN", "url.full": "https://private/path",
            "hindsight.bank_id": "CANARY_BANK", "exception.message": "CANARY_SECRET",
            "gen_ai.usage.input_tokens": 123, "gen_ai.request.model": "model-v1",
            "http.route": "/v1/default/banks/CANARY_BANK/documents/CANARY_DOCUMENT",
        })
        self.assertNotIn("CANARY", str(attrs))
        self.assertEqual(attrs["gen_ai.usage.input_tokens"], 123)
        self.assertEqual(attrs["gen_ai.request.model"], "model-v1")

    def test_span_names_and_log_bodies_have_no_content(self):
        self.assertNotIn("CANARY", module.safe_name("POST /banks/CANARY/memories/recall?query=CANARY"))
        self.assertEqual(module.safe_name("chat CANARY"), "hindsight.operation")
        self.assertEqual(module.log_event("CANARY request failed with CANARY"), "Hindsight operation failed")
        self.assertEqual(module.log_event("CANARY_PROMPT"), "Hindsight runtime event")

    def test_metric_payload_is_copied_without_private_labels_or_exemplars(self):
        @dataclass
        class Node:
            resource_metrics: object = None
            resource: object = None
            scope_metrics: object = None
            metrics: object = None
            data: object = None
            data_points: object = None
            attributes: object = None
            exemplars: object = None
            value: int = 0

        point = Node(value=7, attributes={"bank_id": "CANARY_BANK", "tenant": "CANARY_TENANT", "password": 123456, "scope": "retain", "success": "true", "token_bucket": "50k+", "http.target": "/banks/CANARY/documents/CANARY"}, exemplars=["CANARY_EXEMPLAR"])
        payload = Node(resource_metrics=[Node(resource="CANARY_RESOURCE", scope_metrics=[Node(metrics=[Node(data=Node(data_points=[point]))])])])
        cleaned = module.safe_metrics(payload, "safe-resource")
        result = cleaned.resource_metrics[0].scope_metrics[0].metrics[0].data.data_points[0]
        self.assertNotIn("CANARY", str(cleaned))
        self.assertNotIn("password", result.attributes)
        self.assertEqual(result.value, 7)
        self.assertEqual(result.attributes["scope"], "retain")
        self.assertEqual(result.attributes["token_bucket"], "50k+")
        self.assertEqual(result.exemplars, [])
        self.assertEqual(point.exemplars, ["CANARY_EXEMPLAR"])
        self.assertEqual(module.safe_route("/CANARY_UNKNOWN_PATH"), "/other")
        self.assertNotIn("http.method", module.safe_attributes({"http.method": "CANARY_METHOD"}))

    def test_filter_runs_before_sdk_storage(self):
        class Status:
            def __init__(self, status_code, description=None):
                self.status_code, self.description = status_code, description

        class Span:
            def __init__(self):
                self.attributes, self.events = {}, []
            def set_attribute(self, key, value):
                self.attributes[key] = value
            def set_attributes(self, attributes):
                self.attributes.update(attributes)
            def update_name(self, name):
                self.name = name
            def set_status(self, status):
                self.status = status
            def add_event(self, name, attributes=None):
                self.events.append((name, attributes))
            def record_exception(self, error):
                self.events.append(str(error))

        class Tracer:
            def start_span(self, name, **options):
                self.received = {"name": name, **options}
                return Span()

        @dataclass
        class Measurement:
            value: float
            time_unix_nano: int
            instrument: object
            context: object
            attributes: object = None

        module.install_sdk_filters(Tracer, Span, Measurement, Status)
        tracer = Tracer()
        span = tracer.start_span("chat CANARY", attributes={"gen_ai.input.messages": "CANARY", "gen_ai.usage.input_tokens": 7}, links=["CANARY"])
        self.assertNotIn("CANARY", str(tracer.received))
        span.set_attribute("gen_ai.output.messages", "CANARY")
        span.set_attributes({"password": "CANARY", "http.response.status_code": 200})
        span.update_name("CANARY")
        span.set_status(Status(2, "CANARY"))
        span.add_event("CANARY")
        span.record_exception(RuntimeError("CANARY"))
        self.assertNotIn("CANARY", str(vars(span)))
        self.assertEqual(span.attributes, {"http.response.status_code": 200})
        self.assertIsNone(span.status.description)
        self.assertEqual(span.events, [])
        point = Measurement(42, 1, None, None, {"bank_id": "CANARY", "scope": "retain"})
        self.assertEqual(point.value, 42)
        self.assertEqual(point.attributes, {"scope": "retain"})

    def test_invalid_attribute_values_fail_closed(self):
        self.assertEqual(module.safe_attributes({"gen_ai.usage.input_tokens": float("nan"), "gen_ai.request.model": "model with CANARY secret", "unknown": "CANARY"}), {})


if __name__ == "__main__":
    unittest.main()
