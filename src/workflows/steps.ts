import { checkType, sharedPipeline, type PipelineVersion, type Submission } from "../domain/court.ts";
import { finishCase, openSession, recordEvents } from "../store.ts";
import type { RecordedEvent } from "../domain/court.ts";
import { mockAiEnabled } from "../court/mock.ts";
import { requestedPipeline } from "../instruction/rollout.ts";
import { getWorkflowMetadata, setAttributes } from "workflow";
import { caseLog, errorFields, observeCaseStep } from "../lib/case-telemetry.ts";

export async function openCase(caseId: string, latestPipeline = false): Promise<{ submission: Submission; today: string; simulated: boolean; pipelineVersion: PipelineVersion }> {
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
    const { submission, pipelineVersion = 1 } = await openSession(caseId, (stored) => requestedPipeline(caseId, simulated, checkType(stored), latestPipeline));
    const today = sharedPipeline(pipelineVersion) ? new Date().toISOString().slice(0, 10) : new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" });
    caseLog(caseId, "info", "case.opened", { "case.pipeline": pipelineVersion, "case.check": checkType(submission), simulated });
    return { submission, today, simulated, pipelineVersion };
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
