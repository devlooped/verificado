import type { Event, GetHookParams, GetWorkflowRunParams, Hook, ListEventsByCorrelationIdParams, WorkflowRun } from "@workflow/world";
import { continuationJson } from "../domain/continuation.ts";
import { parseRetryContract, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryRepository } from "../domain/retry-state.ts";

// Read-only projections of the installed World API. No bootstrap, writes,
// resumeHook, token takeover or claims about remote retention/deployment code.
export interface RetryWorldReader {
  runs: { get(runId: string, params?: GetWorkflowRunParams): Promise<Pick<WorkflowRun, "runId" | "deploymentId" | "status">> };
  hooks: { getByToken(token: string, params?: GetHookParams): Promise<Pick<Hook, "runId" | "hookId" | "token">> };
  events: { listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<{ data: Event[]; cursor: string | null; hasMore: boolean }> };
}
export type RetryHookRegistration = { runId: string; hookId: string; eventId: string };

function unavailable(): never { throw new Error("Retry hook registration unverified"); }

// Call only AFTER createHook().getConflict() has actually suspended/resumed.
// The caller identifies the configured World; the binding is not inferred from
// an environment variable or a retained hook entity on a terminal run.
async function readRetryHookRegistration(record: RetryRecord, worldId: string, world: RetryWorldReader): Promise<RetryHookRegistration> {
  const contract = parseRetryContract(record.contract), pause = record.pause, fence = record.fence;
  if (!contract || contract.binding.world !== worldId || !pause || !fence ||
      fence.caseId !== contract.creation.caseId || fence.runId !== contract.binding.runId ||
      pause.attempt !== fence.attempt || pause.epoch !== fence.epoch || !["pausing", "paused"].includes(record.state)) unavailable();
  const run = await world.runs.get(fence.runId, { resolveData: "none" });
  if (run.runId !== fence.runId || run.deploymentId !== contract.binding.deploymentId || run.status !== "running") unavailable();
  const hook = await world.hooks.getByToken(pause.token, { resolveData: "none" });
  if (!hook.hookId || hook.runId !== fence.runId || hook.token !== pause.token || (pause.hookId && hook.hookId !== pause.hookId)) unavailable();
  let registration: RetryHookRegistration | null = null, cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    // hook_created's token is required: a metadata-only/partial read is not proof.
    const events = await world.events.listByCorrelationId({ runId: fence.runId, correlationId: hook.hookId,
      resolveData: "all", pagination: { limit: 100, sortOrder: "asc", ...(cursor ? { cursor } : {}) } });
    for (const event of events.data) {
      if (event.runId !== fence.runId || event.correlationId !== hook.hookId) unavailable();
      if (event.eventType === "hook_disposed" || event.eventType === "hook_conflict") unavailable();
      if (event.eventType === "hook_created") {
        if (registration || !event.eventId || event.eventData?.token !== pause.token || event.eventData.force || event.eventData.forceClaimedFrom) unavailable();
        registration = { runId: fence.runId, hookId: hook.hookId, eventId: event.eventId };
      }
    }
    if (!events.hasMore) {
      if (!registration || (pause.registrationEventId && pause.registrationEventId !== registration.eventId)) unavailable();
      // Recheck after pagination: do not expose a hook lost/reassigned, or a run
      // that became terminal while the journal was being read. The transactional
      // repository fence still owns publication; this is not a cross-store lock.
      const currentRun = await world.runs.get(fence.runId, { resolveData: "none" });
      const currentHook = await world.hooks.getByToken(pause.token, { resolveData: "none" });
      if (currentRun.runId !== run.runId || currentRun.deploymentId !== run.deploymentId || currentRun.status !== "running" ||
          currentHook.hookId !== hook.hookId || currentHook.runId !== hook.runId || currentHook.token !== hook.token) unavailable();
      return registration;
    }
    if (!events.cursor || cursors.has(events.cursor)) unavailable();
    cursor = events.cursor; cursors.add(cursor);
  }
  return unavailable(); // Incomplete/oversized journal remains blocked.
}

export async function observeRetryHookRegistration(record: RetryRecord, worldId: string, world: RetryWorldReader): Promise<RetryHookRegistration> {
  try { return await readRetryHookRegistration(record, worldId, world); }
  catch { return unavailable(); } // SDK exceptions can include private hook tokens.
}

export async function confirmRegisteredRetryPause(repository: Pick<RetryRepository, "read" | "confirmPause">,
  fence: RetryFence, pauseId: string, worldId: string, world: RetryWorldReader): Promise<void> {
  const record = await repository.read(fence.caseId);
  if (!record || continuationJson(record.fence) !== continuationJson(fence) || record.pause?.id !== pauseId) unavailable();
  const registration = await observeRetryHookRegistration(record, worldId, world);
  await repository.confirmPause(fence, pauseId, registration);
}
