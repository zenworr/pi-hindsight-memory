import type { CanonicalTurn } from "../common/types.js";

export { REDACTION_POLICY_VERSION } from "../common/types.js";

type Replacement = (...args: unknown[]) => string;
type RedactionRule = { name: string; pattern: RegExp; replacement: Replacement };
const group = (args: unknown[], index: number): string => typeof args[index] === "string" ? args[index] as string : "";

const RULES: RedactionRule[] = [
  { name: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: () => "[REDACTED:PRIVATE_KEY]" },
  { name: "AUTHORIZATION_HEADER", pattern: /((?:authorization|proxy-authorization|x-api-key)\s*:\s*(?:(?:bearer|basic|token)\s+)?)[A-Za-z0-9._~+/=-]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:AUTH_TOKEN]` },
  { name: "COOKIE_HEADER", pattern: /((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:COOKIE]` },
  { name: "DATABASE_PASSWORD", pattern: /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:DATABASE_PASSWORD]${group(args, 2)}` },
  { name: "URL_CREDENTIAL", pattern: /(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:URL_PASSWORD]${group(args, 2)}` },
  { name: "URL_QUERY_SECRET", pattern: /([?&](?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)=)[^&#\s"'<>]+/gi, replacement: (...args) => group(args, 0).includes("[REDACTED:") ? group(args, 0) : `${group(args, 1)}[REDACTED:URL_SECRET]` },
  { name: "SECRET_ASSIGNMENT", pattern: /(^|[\s{\[,;(])(["']?)((?:[A-Z_][A-Z0-9_-]*)?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIALS?|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE)(?:[_-][A-Z0-9_-]+)?)(\2\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]#]+)/gim, replacement: (...args) => {
    const value = group(args, 5);
    if (value.includes("[REDACTED:")) return group(args, 0);
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${group(args, 1)}${group(args, 2)}${group(args, 3)}${group(args, 4)}${quote}[REDACTED:SECRET]${quote}`;
  } },
  { name: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: () => "[REDACTED:AWS_ACCESS_KEY]" },
  { name: "AWS_SECRET_KEY", pattern: /(^|[\r\n])((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[=:]\s*)[^\s#\r\n]+/gim, replacement: (...args) => `${group(args, 1)}${group(args, 2)}[REDACTED:AWS_SECRET_KEY]` },
  { name: "GITHUB_TOKEN", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: () => "[REDACTED:GITHUB_TOKEN]" },
  { name: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: () => "[REDACTED:OPENAI_API_KEY]" },
  { name: "GOOGLE_KEY", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: () => "[REDACTED:GOOGLE_API_KEY]" },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: () => "Bearer [REDACTED:BEARER_TOKEN]" },
];

export interface RedactionResult { text: string; count: number; rules: string[]; }

export function redactText(input: string): RedactionResult {
  let text = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let count = 0;
  const rules = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const replacement = rule.replacement(...args);
      if (replacement !== args[0]) { count += 1; rules.add(rule.name); }
      return replacement;
    });
  }
  return { text, count, rules: [...rules] };
}

export function redactTurn(turn: CanonicalTurn): RedactionResult & { turn: CanonicalTurn } {
  const result = redactText(turn.content);
  return { ...result, turn: { ...turn, content: result.text } };
}
