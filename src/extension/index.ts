import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig } from "../common/config.js";
import { errorMessage } from "../common/logging.js";
import { stripInjectedMemory } from "../canonical/injected-memory.js";
import { redactText } from "../canonical/redact.js";
import { HindsightClient } from "../hindsight/client.js";
import { formatRecallResponse, type MemorySearchDetails } from "../hindsight/response-format.js";
import { registerHindsightStatusProvider } from "./status.js";

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
    promptGuidelines: [
      "Use memory_search when earlier sessions, preferences, corrections, decisions, failures, or known environment facts can help.",
      "When memory_search returns conflicting states, use timestamps and supporting evidence to identify the latest applicable state; ranking scores are not recency or confidence values.",
    ],
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

export default function piHindsightMemory(pi: ExtensionAPI): void {
  const config = loadConfig();
  const client = new HindsightClient(config.hindsight);
  let unregisterStatusProvider: (() => void) | undefined;
  let toolRegistered = false;
  pi.on("session_start", () => {
    unregisterStatusProvider ??= registerHindsightStatusProvider(pi, config, client);
    if (toolRegistered) return;
    const collision = pi.getAllTools().find((tool) => tool.name === "memory_search");
    if (collision) throw new Error(`pi-hindsight-memory refused to load: memory_search is already registered by ${collision.sourceInfo?.path ?? "another extension"}`);
    pi.registerTool(createMemorySearchTool(client, config.hindsight.minRelevanceScore));
    toolRegistered = true;
  });
  pi.on("session_shutdown", () => {
    unregisterStatusProvider?.();
    unregisterStatusProvider = undefined;
  });
}
