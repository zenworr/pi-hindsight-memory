import { documentIdFor } from "../common/hashing.js";
import type { AppConfig } from "../common/types.js";
import type { HindsightClient } from "../hindsight/client.js";
import { buildCleanupPlan, revalidateCleanupJob } from "./cleanup-plan.js";
import type { CleanupPlan } from "./cleanup-plan.js";
import { removeEvidence } from "./evidence.js";
import { normalizeSessionLabel } from "./exclusions.js";
import { withStateLock } from "./lock.js";

type CleanupApproval = Pick<CleanupPlan, "planHash" | "config" | "jobs"> & { jobIds?: ReadonlySet<string> };

export async function cleanupSubagents(config: AppConfig, client: HindsightClient, approval: CleanupApproval) {
  return withStateLock(config, async (state) => {
    const plan = await buildCleanupPlan(config, client, { includeAmbiguous: approval.config?.includeAmbiguous });
    if (plan.planHash !== approval.planHash || JSON.stringify(plan.config) !== JSON.stringify(approval.config) || JSON.stringify(plan.jobs) !== JSON.stringify(approval.jobs)) throw new Error("Cleanup plan changed after review; make and review a new plan");
    const jobs = plan.jobs.filter((job) => !approval.jobIds || approval.jobIds.has(job.jobId));
    if (approval.jobIds && jobs.length !== approval.jobIds.size) throw new Error("Cleanup job is not in the reviewed plan");
    const summary = { artifacts: plan.artifacts.total, subagentArtifacts: plan.artifacts.subagents, configuredArtifacts: plan.artifacts.configured, ambiguousArtifacts: plan.artifacts.ambiguous, primaryArtifacts: plan.artifacts.primary, planned: 0, remoteDeleted: 0, excluded: 0 };
    for (const job of jobs) {
      await revalidateCleanupJob(config, state, client, job, plan.config.includeAmbiguous);
      const now = new Date().toISOString();
      for (const generation of job.generations) {
        if (generation.phase) continue;
        state.planCleanupJob({ jobId: generation.jobId, action: "delete-document", targetKind: job.targetKind, source: job.source, nativeSessionId: job.nativeSessionId, documentId: job.documentId, canonicalHash: generation.canonicalHash, oldOperationId: generation.operationId, phase: "planned", createdAt: now, updatedAt: now });
        summary.planned += 1;
      }
      if (job.remoteDocumentPresent) {
        await client.deleteDocument(job.documentId, undefined, { retry: false });
        if (await client.getDocument(job.documentId)) throw new Error(`Cleanup could not verify deletion: ${job.documentId}; make and review a new plan`);
        summary.remoteDeleted += 1;
      }
      for (const generation of job.generations) state.updateCleanupJob(generation.jobId, "remote_deleted");
      removeEvidence(config, job.documentId);
      if (job.targetKind === "configured-exclusion" && job.label) {
        state.recordExclusionTombstone({ source: job.source, nativeSessionId: job.sourceNativeSessionId, documentId: documentIdFor(job.source, job.sourceNativeSessionId), locator: job.locator, label: job.label, normalizedLabel: normalizeSessionLabel(job.label), createdAt: now, updatedAt: now });
      }
      for (const generation of job.generations) {
        const operation = job.operations.find((item) => item.operationId === generation.operationId);
        if (!operation || operation.localOnly) state.releaseBudget(generation.operationId);
        state.finalizeExcluded(job.source, job.nativeSessionId, generation.canonicalHash, `Excluded ${job.targetKind} session: ${job.reason}`, job.targetKind, generation.jobId);
        summary.excluded += 1;
      }
    }
    return summary;
  });
}
