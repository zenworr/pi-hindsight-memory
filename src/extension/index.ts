import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig } from "../common/config.js";
import { errorMessage } from "../common/logging.js";
import { stripInjectedMemory } from "../canonical/injected-memory.js";
import { redactText } from "../canonical/redact.js";
import { HindsightClient } from "../hindsight/client.js";
import { formatRecallResponse, type MemorySearchDetails } from "../hindsight/response-format.js";
import { writeDirtyMarkerAsync } from "../importer/dirty-markers.js";

const memorySearchParameters = Type.Object({
  query: Type.String({ description: "A concise natural-language query about prior work, preferences, decisions, corrections, failures, or session evidence." }),
});
type MemorySearchParameters = Static<typeof memorySearchParameters>;

export function createMemorySearchTool(client: HindsightClient, minRelevanceScore?: number): ToolDefinition<typeof memorySearchParameters, MemorySearchDetails> {
  return {
    name: "memory_search",
    label: "memory_search",
    description: "Search the global memory of prior coding-agent sessions for relevant preferences, corrections, decisions, failures, experiences, and evidence.",
    promptSnippet: "Search global memory of prior sessions",
    promptGuidelines: ["Use memory_search when earlier sessions, preferences, corrections, decisions, failures, or known environment facts can help."],
    parameters: memorySearchParameters,
    async execute(_toolCallId, params: MemorySearchParameters, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("memory_search query must not be empty");
      try {
        const response = await client.recall(query, signal);
        const formatted = formatRecallResponse(response, { minRelevanceScore });
        return { content: [{ type: "text", text: formatted.text }], details: formatted.details };
      } catch (error) {
        const message = redactText(stripInjectedMemory(errorMessage(error))).text.slice(0, 1_000);
        throw new Error(`memory_search failed: ${message}`);
      }
    },
  };
}

function markCurrentPiSession(config: ReturnType<typeof loadConfig>, ctx: ExtensionContext, reason: "session_compact" | "session_shutdown"): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const sessionId = ctx.sessionManager.getSessionId();
  // Do not make Pi await filesystem work during shutdown or compaction. The scanner is authoritative.
  void writeDirtyMarkerAsync(config.dirtyDirectory, { source: "pi", sessionFile, sessionId, reason });
}

export default function piHindsightMemory(pi: ExtensionAPI): void {
  const config = loadConfig();
  const client = new HindsightClient(config.hindsight);
  let toolRegistered = false;
  pi.on("session_start", () => {
    if (toolRegistered) return;
    const collision = pi.getAllTools().find((tool) => tool.name === "memory_search");
    if (collision) throw new Error(`pi-hindsight-memory refused to load: memory_search is already registered by ${collision.sourceInfo?.path ?? "another extension"}`);
    pi.registerTool(createMemorySearchTool(client, config.hindsight.minRelevanceScore));
    toolRegistered = true;
  });
  pi.on("session_compact", (_event, ctx) => { markCurrentPiSession(config, ctx, "session_compact"); });
  pi.on("session_shutdown", (_event, ctx) => { markCurrentPiSession(config, ctx, "session_shutdown"); });
}
