import importlib.util
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

    def test_invalid_attribute_values_fail_closed(self):
        self.assertEqual(module.safe_attributes({"gen_ai.usage.input_tokens": float("nan"), "gen_ai.request.model": "model with CANARY secret", "unknown": "CANARY"}), {})


if __name__ == "__main__":
    unittest.main()
