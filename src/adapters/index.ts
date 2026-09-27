import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../common/types.js";
import type { SessionAdapter } from "./adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpenCodeAdapter } from "./opencode.js";
import { OriginAdapter } from "./origin.js";
import { PiAdapter } from "./pi.js";

export function createAdapters(config: AppConfig): SessionAdapter[] {
  const native: SessionAdapter[] = [
    new PiAdapter(config.sourceRoots.pi),
    new CodexAdapter(config.sourceRoots.codex, config.codexStateDatabase),
    new ClaudeAdapter(config.sourceRoots.claude),
    new OpenCodeAdapter(config.opencodeDatabase),
  ];
  if (!config.desktopFeed.enabled) return native;

  const directory = fs.realpathSync(config.desktopFeed.directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (manifest.version !== 1 || manifest.origin !== "desktop" || manifest.sourceHome !== config.desktopFeed.sourceHome || manifest.generation !== path.basename(directory)) {
    throw new Error("The desktop feed has no valid completed generation");
  }
  const home = config.desktopFeed.sourceHome;
  const feed = [
    new PiAdapter(path.join(directory, "pi")),
    new CodexAdapter(path.join(directory, "codex"), path.join(directory, "codex-state", "state_5.sqlite")),
    new ClaudeAdapter(path.join(directory, "claude")),
    new OpenCodeAdapter(path.join(directory, "opencode", "opencode.db")),
  ];
  const nativeRoots = [config.sourceRoots.pi, config.sourceRoots.codex, config.sourceRoots.claude, config.opencodeDatabase];
  const physicalRoots = [path.join(directory, "pi"), path.join(directory, "codex"), path.join(directory, "claude"), path.join(directory, "opencode", "opencode.db")];
  const logicalRoots = [path.join(home, ".pi/agent/sessions"), path.join(home, ".codex/sessions"), path.join(home, ".claude/projects"), path.join(home, ".local/share/opencode/opencode.db")];
  return [
    ...native.map((adapter, index) => new OriginAdapter(adapter, config.localOrigin, nativeRoots[index]!, nativeRoots[index]!)),
    ...feed.map((adapter, index) => new OriginAdapter(adapter, "desktop", physicalRoots[index]!, logicalRoots[index]!, path.join(config.desktopFeed.directory, path.relative(directory, physicalRoots[index]!)))),
  ];
}
