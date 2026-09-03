import type { AppConfig } from "../common/types.js";
import type { SessionAdapter } from "./adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";

export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { OpenCodeAdapter } from "./opencode.js";
export { PiAdapter } from "./pi.js";
export * from "./adapter.js";

export function createAdapters(config: AppConfig): SessionAdapter[] {
  return [
    new PiAdapter(config.sourceRoots.pi),
    new CodexAdapter(config.sourceRoots.codex, config.codexStateDatabase),
    new ClaudeAdapter(config.sourceRoots.claude),
    new OpenCodeAdapter(config.opencodeDatabase),
  ];
}
