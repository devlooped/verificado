import { getRun, start } from "workflow/api";
import { startCaseWorkflow } from "../store.ts";
import { courtSession } from "../workflows/court-session.ts";
import { requireContinuationEnabled } from "../domain/continuation.ts";

export async function cancelCaseRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (await run.status === "cancelled") return;
  try { await run.cancel({ cancelReason: "Detenido por un administrador" }); }
  catch (error) {
    // Cancellation may have succeeded even if its response was lost.
    if (await run.status !== "cancelled") throw error;
  }
}

export async function startCourtSession(caseId: string, latestPipeline = false): Promise<void> {
  // The explicit flag keeps the replay of runs started before summaries unchanged.
  await startCaseWorkflow(caseId, () => start(courtSession, [caseId, latestPipeline, true, true]), cancelCaseRun);
}

// No live implementation/fallback until the remaining safety gates are proved.
// In particular, never route this to startCourtSession or a destructive reset.
export async function startCourtContinuation(_caseId: string): Promise<void> {
  requireContinuationEnabled();
}
