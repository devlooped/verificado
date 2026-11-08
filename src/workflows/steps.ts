import { caseDate } from "../domain/case-date.ts";
import { checkType, sharedPipeline, type PipelineVersion, type Submission } from "../domain/court.ts";
import { finishCase, openSession, recordEvents, registerContinuationRun } from "../store.ts";
import type { ContinuationReservation, ContinuationWriter } from "../domain/continuation.ts";
import type { RecordedEvent } from "../domain/court.ts";
import { mockAiEnabled } from "../court/mock.ts";
import { requestedPipeline } from "../instruction/rollout.ts";
import { getWorkflowMetadata, setAttributes } from "workflow";
import { caseLog, errorFields, observeCaseStep } from "../lib/case-telemetry.ts";

export async function openCase(caseId: string, latestPipeline = false): Promise<{ submission: Submission; today: string; caseDate: string; simulated: boolean; pipelineVersion: PipelineVersion }> {
  "use step";
  return observeCaseStep(caseId, "open", {}, async () => {
    // Make the run discoverable by case ID in the Workflow dashboard/CLI.
    let inWorkflow = false;
    try { getWorkflowMetadata(); inWorkflow = true; } catch { /* direct invocation */ }
    if (inWorkflow) {
      try { await setAttributes({ case_id: caseId }); }
      catch (error) { caseLog(caseId, "warn", "case.workflow.attributes_failed", errorFields(error)); }
    }
    const simulated = mockAiEnabled();
    const { submission, createdAt, pipelineVersion = 1 } = await openSession(caseId, (stored) => requestedPipeline(caseId, simulated, checkType(stored), latestPipeline));
    const today = sharedPipeline(pipelineVersion) ? new Date().toISOString().slice(0, 10) : new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" });
    caseLog(caseId, "info", "case.opened", { "case.pipeline": pipelineVersion, "case.check": checkType(submission), simulated });
    return { submission, today, caseDate: caseDate(createdAt), simulated, pipelineVersion };
  });
}

export async function saveEvents(caseId: string, events: RecordedEvent[]): Promise<void> {
  "use step";
  await observeCaseStep(caseId, "save_events", { "events.count": events.length }, async () => {
    await recordEvents(caseId, events);
    caseLog(caseId, "info", "case.events.saved", { "events.count": events.length, "events.types": [...new Set(events.map((event) => event.type))].join(","), "events.last_seq": events.at(-1)?.seq ?? 0 });
    for (const event of events) {
      if (event.type === "source_collection_started") caseLog(caseId, "info", "case.sources.collection_started", { "sources.total": event.total, "sources.batches": event.batches, "events.seq": event.seq });
      if (event.type === "source_batch_started") caseLog(caseId, "info", "case.sources.batch_started", { "sources.batch": event.batch, "sources.batches": event.batches, "sources.count": event.urls.length, "events.seq": event.seq });
      if (event.type === "source_batch_completed") caseLog(caseId, event.failed ? "warn" : "info", "case.sources.batch_completed", { "sources.batch": event.batch, "sources.batches": event.batches, "sources.count": event.count, "sources.completed": event.completed, "sources.total": event.total, "sources.failed": event.failed, "events.seq": event.seq });
    }
  });
}

export async function closeCase(caseId: string, status: "resolved" | "failed", error?: string): Promise<void> {
  "use step";
  await observeCaseStep(caseId, "close", { "case.status": status }, async () => {
    await finishCase(caseId, status, error);
    caseLog(caseId, status === "failed" ? "error" : "info", "case.closed", { "case.status": status });
  });
}

// Separate first step for a future continuation workflow; never insert this
// invocation into the replay sequence of courtSession runs already active.
export async function registerContinuationCaseRun(caseId: string, reservation: ContinuationReservation): Promise<ContinuationWriter> {
  "use step";
  const { workflowRunId } = getWorkflowMetadata();
  await registerContinuationRun(caseId,reservation,workflowRunId);
  return {generation:reservation.generation,runId:workflowRunId};
}

// Keep generation-aware signatures separate from legacy replay entry points.
export async function saveContinuationEvents(caseId: string, writer: ContinuationWriter, events: RecordedEvent[]): Promise<void> {
  "use step";
  if (getWorkflowMetadata().workflowRunId !== writer.runId) throw new Error("Continuation writer does not match executing run");
  await recordEvents(caseId,events,writer);
}

export async function closeContinuationCase(caseId: string, writer: ContinuationWriter, status: "resolved" | "failed", error?: string): Promise<void> {
  "use step";
  if (getWorkflowMetadata().workflowRunId !== writer.runId) throw new Error("Continuation writer does not match executing run");
  await finishCase(caseId,status,error,writer);
}
