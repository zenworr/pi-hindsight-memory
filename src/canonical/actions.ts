import { redactText } from "./redact.js";

const MAX_ACTION_BYTES = 800;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shorten(value: string): string {
  const redacted = redactText(value).text.replaceAll("\n", " ").replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(redacted, "utf8") <= MAX_ACTION_BYTES) return redacted;
  let output = redacted.slice(0, MAX_ACTION_BYTES - 1);
  while (Buffer.byteLength(output, "utf8") > MAX_ACTION_BYTES - 1) output = output.slice(0, -1);
  return `${output}…`;
}

function inputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export function actionText(toolName: unknown, input: unknown): string {
  const name = stringValue(toolName) ?? "unknown tool";
  const args = inputObject(input);
  const path = stringValue(args.path) ?? stringValue(args.file_path) ?? stringValue(args.filePath);
  const command = stringValue(args.command) ?? stringValue(args.cmd);
  const query = stringValue(args.query) ?? stringValue(args.pattern) ?? stringValue(args.search);
  const url = stringValue(args.url) ?? stringValue(args.uri);
  const file = path ? ` ${shorten(path)}` : "";
  if (["read", "cat", "view_file"].includes(name.toLowerCase())) return `Read${file}`;
  if (["write", "edit", "apply_patch", "patch"].includes(name.toLowerCase())) return `${name === "write" ? "Write" : "Edit"}${file}`;
  if (["bash", "shell", "command", "terminal", "exec", "run_command"].includes(name.toLowerCase())) return `Run${command ? ` ${shorten(command)}` : " shell command"}`;
  if (["grep", "rg", "search", "find", "glob"].includes(name.toLowerCase())) return `Search${query ? ` ${shorten(query)}` : ""}`;
  if (["web_fetch", "fetch", "browser", "open_url"].includes(name.toLowerCase())) return `Fetch${url ? ` ${shorten(url)}` : " URL"}`;
  if (["memory_search", "hindsight_recall", "hermes_memory_search"].includes(name.toLowerCase())) return "Search prior memory";
  if (path) return `${name} ${shorten(path)}`;
  if (command) return `${name} ${shorten(command)}`;
  if (query) return `${name} ${shorten(query)}`;
  if (url) return `${name} ${shorten(url)}`;
  return `Use ${shorten(name)}`;
}
