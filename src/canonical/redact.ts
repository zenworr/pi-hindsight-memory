import type { CanonicalTurn } from "../common/types.js";

export const REDACTION_POLICY_VERSION = "2";

type Replacement = (...args: unknown[]) => string;
type RedactionRule = { name: string; pattern: RegExp; replacement: Replacement };
const group = (args: unknown[], index: number): string => typeof args[index] === "string" ? args[index] as string : "";

const RULES: RedactionRule[] = [
  { name: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: () => "[REDACTED:PRIVATE_KEY]" },
  { name: "AUTHORIZATION_HEADER", pattern: /((?:authorization|proxy-authorization|x-api-key)\s*:\s*(?:bearer\s+)?)[A-Za-z0-9._~+/=-]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:AUTH_TOKEN]` },
  { name: "COOKIE_HEADER", pattern: /((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:COOKIE]` },
  { name: "DATABASE_PASSWORD", pattern: /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:DATABASE_PASSWORD]${group(args, 2)}` },
  { name: "URL_CREDENTIAL", pattern: /(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:URL_PASSWORD]${group(args, 2)}` },
  { name: "URL_QUERY_SECRET", pattern: /([?&](?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|sig|signature)=)[^&#\s]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:URL_SECRET]` },
  { name: "JSON_SECRET", pattern: /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret|token|private[_-]?key)["']?\s*:\s*["'])([^"'\r\n]*)(["'])/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:JSON_SECRET]${group(args, 3)}` },
  { name: "ENV_SECRET", pattern: /(^|[\r\n])(\s*[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)([^\s#\r\n]+)/gim, replacement: (...args) => `${group(args, 1)}${group(args, 2)}[REDACTED:ENV_SECRET]` },
  { name: "YAML_SECRET", pattern: /(^|[\r\n])(\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret|token|private[_-]?key)\s*:\s*)([^\s#\r\n]+)/gim, replacement: (...args) => `${group(args, 1)}${group(args, 2)}[REDACTED:YAML_SECRET]` },
  { name: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: () => "[REDACTED:AWS_ACCESS_KEY]" },
  { name: "AWS_SECRET_KEY", pattern: /(^|[\r\n])((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[=:]\s*)[^\s#\r\n]+/gim, replacement: (...args) => `${group(args, 1)}${group(args, 2)}[REDACTED:AWS_SECRET_KEY]` },
  { name: "GITHUB_TOKEN", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: () => "[REDACTED:GITHUB_TOKEN]" },
  { name: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: () => "[REDACTED:OPENAI_API_KEY]" },
  { name: "GOOGLE_KEY", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: () => "[REDACTED:GOOGLE_API_KEY]" },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: () => "Bearer [REDACTED:BEARER_TOKEN]" },
];

export interface RedactionResult { text: string; count: number; rules: string[]; }

export function redactText(input: string): RedactionResult {
  let text = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let count = 0;
  const rules = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1; rules.add(rule.name); return rule.replacement(...args);
    });
  }
  return { text, count, rules: [...rules] };
}

export function redactTurn(turn: CanonicalTurn): RedactionResult & { turn: CanonicalTurn } {
  const result = redactText(turn.content);
  return { ...result, turn: { ...turn, content: result.text } };
}
