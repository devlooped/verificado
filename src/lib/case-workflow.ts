import { getRun, start } from "workflow/api";
import { startCaseWorkflow } from "../store.ts";
import { courtSession } from "../workflows/court-session.ts";

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
  await startCaseWorkflow(caseId, () => start(courtSession, latestPipeline ? [caseId, true] : [caseId]), cancelCaseRun);
}
