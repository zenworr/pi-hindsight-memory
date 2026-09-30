import { devNull } from "node:os";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("OTEL_")) delete process.env[key];
}
process.env.PI_HINDSIGHT_TELEMETRY_FILE = devNull;
