import type { CanonicalTurn } from "../common/types.js";

const CAPTURE = { credentialSuffix: 2, assignmentQuote: 2, assignmentName: 3, assignmentSeparator: 4, assignmentValue: 5, awsAssignment: 2 };
const PLACEHOLDER = /^\[REDACTED:[A-Z_]+\]$/;
const JSON_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const SECRET_VALUE = String.raw`(?:${JSON_STRING}|'(?:\\[\s\S]|[^'\\])*'|\[[^\s,;{}\[\]#"'<>]*\]|\]+(?=[^\s,;}\]#"'<>])|[^\s,;{}\]#"'<>])+`;

function replacementValue(value: string, marker: string): string {
  const quote = value.startsWith('"') && value.endsWith('"') ? '"' : value.startsWith("'") && value.endsWith("'") ? "'" : "";
  return PLACEHOLDER.test(quote ? value.slice(1, -1) : value) ? value : `${quote}${marker}${quote}`;
}

interface SecretField { start: number; value: string; }
interface OAuthFields { access: SecretField[]; refresh: SecretField[]; expires: boolean; }

function redactOAuthObjects(text: string): { text: string; count: number } {
  if (!text.includes('"access"') || !text.includes('"refresh"')) return { text, count: 0 };
  const stack: Array<OAuthFields | undefined> = [];
  const fields: SecretField[] = [];
  // Track object boundaries so similarly named fields in unrelated objects do not qualify.
  const tokens = new RegExp(String.raw`([{}\[\]])|(${JSON_STRING})(\s*:\s*(${JSON_STRING})?)?`, "g");
  for (const token of text.matchAll(tokens)) {
    const [part, delimiter, key, assignment, value] = token;
    if (delimiter === "{") stack.push({ access: [], refresh: [], expires: false });
    else if (delimiter === "[") stack.push(undefined);
    else if (delimiter === "]") stack.pop();
    else if (delimiter === "}") {
      const object = stack.pop();
      if (object?.expires && object.access.length && object.refresh.length) for (const field of [...object.access, ...object.refresh]) fields.push(field);
    } else if (assignment) {
      const object = stack.at(-1);
      if (!object) continue;
      if (key === '"expires"') object.expires = true;
      if (value && (key === '"access"' || key === '"refresh"')) {
        const list = key === '"access"' ? object.access : object.refresh;
        list.push({ start: token.index + part.length - value.length, value });
      }
    }
  }
  let offset = 0;
  let count = 0;
  const output = [];
  for (const { start, value } of fields.sort((a, b) => a.start - b.start)) {
    const safe = replacementValue(value, "[REDACTED:OAUTH_TOKEN]");
    if (safe === value) continue;
    output.push(text.slice(offset, start), safe);
    offset = start + value.length;
    count += 1;
  }
  return { text: count ? output.join("") + text.slice(offset) : text, count };
}

function redactOAuthCallback(value: string): string {
  if (!/[?&]code=/i.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  const oauthRoute = /(?:^|\/)(?:oauth2?(?:\/|$|callback(?:\/|$))|callback\/?$)/i.test(url.pathname);
  if (!oauthRoute && !url.searchParams.has("state")) return value;
  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  if (queryStart < 0 || fragmentStart >= 0 && fragmentStart < queryStart) return value;
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  return value.slice(0, queryStart) + value.slice(queryStart, queryEnd).replace(/([?&]code=)[^&]+/gi, "$1[REDACTED:OAUTH_CODE]") + value.slice(queryEnd);
}

type Replacement = (...args: unknown[]) => string;
type RedactionRule = { name: string; pattern: RegExp; replacement: Replacement };
const group = (args: unknown[], index: number): string => typeof args[index] === "string" ? args[index] : "";

const RULES: RedactionRule[] = [
  { name: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: () => "[REDACTED:PRIVATE_KEY]" },
  { name: "AUTHORIZATION_HEADER", pattern: new RegExp(String.raw`(\b(?:authorization|proxy-authorization|x-api-key)[ \t]*:[ \t]*)((?:(?:bearer|basic|token)[ \t]+)?(?:${SECRET_VALUE}))`, "gi"), replacement: (...args) => `${group(args, 1)}${replacementValue(group(args, CAPTURE.credentialSuffix), "[REDACTED:AUTH_TOKEN]")}` },
  { name: "COOKIE_HEADER", pattern: /((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:COOKIE]` },
  { name: "DATABASE_PASSWORD", pattern: /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:DATABASE_PASSWORD]${group(args, CAPTURE.credentialSuffix)}` },
  { name: "URL_CREDENTIAL", pattern: /(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, replacement: (...args) => `${group(args, 1)}[REDACTED:URL_PASSWORD]${group(args, CAPTURE.credentialSuffix)}` },
  { name: "OAUTH_CALLBACK", pattern: /\bhttps?:\/\/[^\s"'<>]+/gi, replacement: (...args) => redactOAuthCallback(group(args, 0)) },
  { name: "URL_QUERY_SECRET", pattern: /([?&](?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)=)([^&#\s"'<>]+)/gi, replacement: (...args) => `${group(args, 1)}${replacementValue(group(args, CAPTURE.credentialSuffix), "[REDACTED:URL_SECRET]")}` },
  { name: "SECRET_ASSIGNMENT", pattern: new RegExp(String.raw`(^|[\s{[,;(])(["']?)((?:[A-Z_][A-Z0-9_-]*)?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIALS?|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE)(?:[_-][A-Z0-9_-]+)?)(\2\s*[:=]\s*)(${SECRET_VALUE})`, "gim"), replacement: (...args) => `${group(args, 1)}${group(args, CAPTURE.assignmentQuote)}${group(args, CAPTURE.assignmentName)}${group(args, CAPTURE.assignmentSeparator)}${replacementValue(group(args, CAPTURE.assignmentValue), "[REDACTED:SECRET]")}` },
  { name: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: () => "[REDACTED:AWS_ACCESS_KEY]" },
  { name: "AWS_SECRET_KEY", pattern: /(^|[\r\n])((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[=:]\s*)[^\s#\r\n]+/gim, replacement: (...args) => `${group(args, 1)}${group(args, CAPTURE.awsAssignment)}[REDACTED:AWS_SECRET_KEY]` },
  { name: "GITHUB_TOKEN", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: () => "[REDACTED:GITHUB_TOKEN]" },
  { name: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: () => "[REDACTED:OPENAI_API_KEY]" },
  { name: "GOOGLE_KEY", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: () => "[REDACTED:GOOGLE_API_KEY]" },
  { name: "BEARER_TOKEN", pattern: new RegExp(String.raw`\bBearer[ \t]+(${SECRET_VALUE})`, "gi"), replacement: (...args) => {
    const value = group(args, 1);
    return PLACEHOLDER.test(value) ? group(args, 0) : `Bearer ${replacementValue(value, "[REDACTED:BEARER_TOKEN]")}`;
  } },
];

export interface RedactionResult { text: string; count: number; rules: string[]; }

export function redactText(input: string): RedactionResult {
  const oauth = redactOAuthObjects(input.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
  let { text, count } = oauth;
  const rules = new Set<string>(count ? ["OAUTH_CREDENTIAL"] : []);
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
