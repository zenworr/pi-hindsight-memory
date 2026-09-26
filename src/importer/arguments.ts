import { parseArgs } from "node:util";
import { positiveInteger } from "../common/config-validation.js";
import { MAX_TIMER_MS } from "../common/limits.js";
import { SOURCES } from "../common/types.js";

const COMMANDS: Record<string, { flags: string[]; positionals: number }> = {
  help: { flags: [], positionals: 0 },
  config: { flags: ["defaults", "check"], positionals: 0 },
  inventory: { flags: ["output", "source", "limit", "summary-only"], positionals: 0 },
  scan: { flags: ["source", "session-id", "limit", "force"], positionals: 0 },
  "index-evidence": { flags: ["source", "session-id", "limit", "force"], positionals: 0 },
  "plan-repair": { flags: ["output"], positionals: 0 },
  repair: { flags: ["plan", "max-ms"], positionals: 0 },
  daemon: { flags: ["once", "no-scan"], positionals: 0 },
  drain: { flags: ["max-ms", "no-scan"], positionals: 0 },
  "process-queued": { flags: ["max-ms"], positionals: 0 },
  "import-all": { flags: ["cohort", "max-ms"], positionals: 0 },
  "verify-import": { flags: [], positionals: 0 },
  "verify-ready": { flags: [], positionals: 0 },
  "plan-cleanup": { flags: ["output", "include-ambiguous"], positionals: 0 },
  "cleanup-subagents": { flags: ["apply", "plan"], positionals: 0 },
  status: { flags: [], positionals: 0 },
  pause: { flags: [], positionals: 0 },
  resume: { flags: [], positionals: 0 },
  "configure-bank": { flags: ["file"], positionals: 0 },
  consolidate: { flags: [], positionals: 0 },
  "enable-auto-consolidation": { flags: [], positionals: 0 },
  "retry-failed": { flags: [], positionals: 0 },
  "cancel-queued": { flags: [], positionals: 0 },
  "dry-run-extract": { flags: ["mode"], positionals: 1 },
  "select-pilot": { flags: ["count", "max-bytes", "include-largest"], positionals: 1 },
  "queue-pilot": { flags: [], positionals: 1 },
  "run-pilot": { flags: [], positionals: 2 },
  "export-canonical": { flags: [], positionals: 3 },
  doctor: { flags: [], positionals: 0 },
};
const BOOLEAN_FLAGS = new Set(["help", "defaults", "check", "summary-only", "force", "once", "no-scan", "include-ambiguous", "apply", "include-largest"]);
const INTEGER_FLAGS = ["limit", "cohort", "max-ms", "count", "max-bytes"];

export interface CommandArguments {
  command: string;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

export function parseArguments(input: string[]): CommandArguments {
  const command = input[0] === "--help" ? "help" : input[0] ?? "help";
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) throw new Error(`Unknown command: ${command}; run --help`);
  const options = Object.fromEntries(["config", "help", ...spec.flags].map((flag) => [flag, { type: BOOLEAN_FLAGS.has(flag) ? "boolean" as const : "string" as const }]));
  const { values, positionals, tokens } = parseArgs({ args: input.slice(1), options, allowPositionals: true, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
    seen.add(token.name);
  }
  if (!values.help && positionals.length !== spec.positionals) throw new Error(`${command} requires ${spec.positionals} positional argument(s); run ${command} --help`);
  if (values.source !== undefined && !SOURCES.some(source => source === values.source)) throw new Error(`Invalid source: ${String(values.source)}`);
  if (values.mode !== undefined && values.mode !== "concise" && values.mode !== "verbose") throw new Error("--mode must be concise or verbose");
  for (const flag of INTEGER_FLAGS) if (values[flag] !== undefined) positiveInteger(Number(values[flag]), `--${flag}`);
  if (values["max-ms"] !== undefined && Number(values["max-ms"]) > MAX_TIMER_MS) throw new Error(`--max-ms exceeds the Node timer limit (${MAX_TIMER_MS} ms)`);
  if (values.defaults && values.check) throw new Error("Use either config --defaults or config --check, not both");
  return { command, values, positionals };
}
