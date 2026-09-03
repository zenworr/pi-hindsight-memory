import { CLASSIFICATION_POLICY_VERSION } from "../common/types.js";
import type { SessionClassification, SessionExclusionConfig } from "../common/types.js";

export function normalizeSessionLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function excludedLabel(label: string | undefined, config: SessionExclusionConfig): string | undefined {
  if (!label) return undefined;
  const normalized = normalizeSessionLabel(label);
  if (!normalized) return undefined;
  const match = config.exactLabels.find((candidate) => normalizeSessionLabel(candidate) === normalized);
  return match;
}

export function configuredExclusion(label: string | undefined, config: SessionExclusionConfig): SessionClassification | undefined {
  const match = excludedLabel(label, config);
  return match ? { kind: "configured-exclusion", reason: `configured-exact-session-label:${match}`, policyVersion: CLASSIFICATION_POLICY_VERSION, label: match } : undefined;
}
