const BLOCK_PATTERNS: RegExp[] = [
  /<memory(?:-context)?\b[^>]*>[\s\S]*?<\/memory(?:-context)?>/gi,
  /<hermes-memory\b[^>]*>[\s\S]*?<\/hermes-memory>/gi,
  /<blackhole-memory\b[^>]*>[\s\S]*?<\/blackhole-memory>/gi,
  /<!--\s*(?:HERMES|BLACKHOLE|HINDSIGHT)[\s\S]*?-->/gi,
  /\[\s*(?:HERMES|BLACKHOLE|HINDSIGHT)\s+(?:MEMORY|RECALL|OBSERVATIONS?)\s*\][\s\S]*?(?=\n\s*\n|$)/gi,
  /<system-reminder>\s*[\s\S]*?<\/system-reminder>/gi,
];

const GENERATED_PREFIXES = [
  "memory_search result",
  "found relevant memory items",
  "retrieved memory:",
  "persistent memory:",
];

export function stripInjectedMemory(input: string): string {
  let text = input;
  for (const pattern of BLOCK_PATTERNS) text = text.replace(pattern, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHarnessContext(input: string): string {
  return input
    .replace(/^# AGENTS\.md instructions(?: for [^\n]+)?\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
    .replace(/^<environment_context>[\s\S]*?<\/environment_context>\s*/i, "")
    .trim();
}

export function isLikelyGeneratedMemory(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isMemorySearchToolName(value: unknown): boolean {
  return typeof value === "string" && ["memory_search", "hindsight_recall", "hermes_memory_search"].includes(value);
}
