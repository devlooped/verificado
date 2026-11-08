import { getWorkflowMetadata } from "workflow";
import { getWorld } from "workflow/runtime";
import { AsyncLocalStorage } from "node:async_hooks";

// A broker request outlives its short binding-consumption transaction. Keep
// that transaction's run identity through ALL its subsequent store/Blob writes.
const brokerRun = new AsyncLocalStorage<string>();
export function withLegacyRunScope<T>(runId: string, work: () => T): T {
  return brokerRun.run(runId, work);
}

export interface RerunWorldReader {
  runs: { get(runId: string, params: { resolveData: "none" }): Promise<{ runId: string; status: string; deploymentId: string }> };
  steps: { list(params: { runId: string; pagination: { cursor?: string }; resolveData: "none" }): Promise<{
    data: { runId: string; status: string; startedAt?: Date }[]; hasMore: boolean; cursor: string | null;
  }> };
}

// Terminal status alone does not prove that an executing step has returned.
// This authorizes a fresh legacy run, NOT deletion of private resources or retry.
export async function rerunRunSettled(runId: string, world?: RerunWorldReader | Promise<RerunWorldReader>): Promise<boolean> {
  try {
    const reader = await (world ?? getWorld());
    const run = await reader.runs.get(runId, { resolveData: "none" });
    if (!runId.trim() || run.runId !== runId || !run.deploymentId?.trim() || !["completed", "failed", "cancelled"].includes(run.status)) return false;
    let cursor: string | undefined;
    let observedStep = false;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const steps = await reader.steps.list({ runId, pagination: { cursor }, resolveData: "none" });
      observedStep ||= steps.data.length > 0;
      if (steps.data.some(step => step.runId !== runId ||
          !["completed", "failed", "pending"].includes(step.status) ||
          (step.status === "pending" && step.startedAt))) return false;
      if (!steps.hasMore) {
        const current = await reader.runs.get(runId, { resolveData: "none" });
        // Every court run has steps. An empty journal may have been pruned;
        // it does not establish that no previous step is still executing.
        return observedStep && current.runId === runId && current.status === run.status && current.deploymentId === run.deploymentId;
      }
      if (!steps.cursor || seen.has(steps.cursor)) return false;
      seen.add(steps.cursor); cursor = steps.cursor;
    }
    return false;
  } catch { return false; } // Missing/partial control-plane evidence is not inactivity.
}

export function legacyWorkflowRunId(read = getWorkflowMetadata): string | undefined {
  const bound = brokerRun.getStore();
  if (bound !== undefined) return bound;
  try { return read().workflowRunId; } catch { return undefined; } // Admins/scripts are not workflow steps.
}

export function assertLegacyRunWriter(runId: string | undefined, currentRunId: string | null, stoppedRunId: string | null): void {
  if (runId && (runId !== currentRunId || stoppedRunId)) throw new Error("Case writer fenced: stale or stopped legacy run");
}
