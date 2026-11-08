import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract, retryPreflight, type RetryFence, type RetryPreflight, type RetryPreflightInput } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryRepository, RetryRequest, RetryUnit } from "../domain/retry-state.ts";

export interface RetryReadOnlyObserver {
  authorize(caseId: string, adminId: string): Promise<boolean>;
  // These are requirements for a trusted adapter, not production attestations
  // implemented by this module. Neither method may bootstrap/write or dispatch.
  observe(record: RetryRecord): Promise<Pick<RetryPreflightInput, "run" | "hook" | "deploymentAvailable" | "retentionVerified" | "quotaVerified" | "evidenceVerified" | "creationRecordedAtomically">>;
  verifyInactivity(unit: RetryUnit): Promise<boolean>;
}
export type RetryAdminView = { preflight: RetryPreflight; nextUnitKey: string | null; runId: string | null };

// No legacy store import: repository.read and observers must be bootstrap-free.
// The response excludes the hook token, private inputs/results and proof bytes.
export async function inspectSameRunRetry(caseId: string, adminId: string, repository: Pick<RetryRepository, "read">, observer: RetryReadOnlyObserver): Promise<RetryAdminView> {
  const blocked = (reason: "not_admin" | "no_creation_contract" | "evidence_unverified"): RetryAdminView => ({ preflight: { eligible: false, state: "blocked", reasons: [reason], estimatedPendingCost: null }, nextUnitKey: null, runId: null });
  if (!adminId.trim() || !await observer.authorize(caseId, adminId)) return blocked("not_admin");
  try {
    const record = await repository.read(caseId);
    if (!record) return blocked("no_creation_contract");
    const contract = parseRetryContract(record.contract);
    const observations = await observer.observe(record);
    const operations = await Promise.all(record.units.map(async unit => ({ state: unit.state, estimatedCost: unit.estimatedCost,
      inactivityProved: unit.state === "proven_failed" && await observer.verifyInactivity(unit) })));
    const exactFence = !!contract && !!record.fence && record.fence.caseId === caseId && record.fence.runId === contract.binding.runId;
    const integrity = record.units.every(unit => unit.inputHash === continuationHash(unit.input) &&
      (unit.state !== "ready" || (unit.result !== undefined && unit.resultHash === continuationHash(unit.result))) &&
      (unit.state !== "skipped" || !!unit.reason?.trim()));
    const pause = record.pause && exactFence && record.pause.attempt === record.fence!.attempt && record.pause.epoch === record.fence!.epoch &&
      record.pause.registrationEventId && record.pause.hookId ? { runId: record.fence!.runId, hookId: record.pause.hookId, attempt: record.pause.attempt, epoch: record.pause.epoch } : null;
    const preflight = retryPreflight({ ...observations, admin: true, caseId, contract: record.contract,
      initialStartReconciled: exactFence && record.startClaimed && !!record.startObservation && !!record.startCandidate && continuationJson(record.startCandidate) === continuationJson(contract!.binding),
      caseState: record.state === "starting" ? "blocked" : record.state, pause, operations,
      evidenceVerified: observations.evidenceVerified && integrity && !!record.pause && record.units.some(unit => unit.key === record.pause!.unitKey && unit.state === "proven_failed"),
    });
    return { preflight, nextUnitKey: record.pause?.unitKey ?? null, runId: record.fence?.runId ?? null };
  } catch { return blocked("evidence_unverified"); }
}

export type RetryDispatchResult = { state: "not_dispatched" | "delivered" | "accepted" | "uncertain" | "blocked"; requestKey: string };
type DispatchRepository = Pick<RetryRepository, "read" | "claimDispatch" | "observeDispatch">;

// Transport/storage protocol ONLY, used by isolated fixtures. No Server Action
// calls it: a live caller must first pass authorization, trusted proofs, the
// hard-disabled route gate and reserveRequest under the exact pause/fence.
export async function dispatchReservedRetry(repository: DispatchRepository, fence: RetryFence, request: RetryRequest,
  resume: (token: string, command: RetryRequest["command"]) => Promise<{ runId: string }>): Promise<RetryDispatchResult> {
  const result = (state: RetryDispatchResult["state"]) => ({ state, requestKey: request.key });
  const record = await repository.read(fence.caseId);
  const saved = record?.requests.find(candidate => candidate.key === request.key);
  if (saved?.state === "accepted") return result("accepted");
  if (!record?.pause || continuationJson(record.fence) !== continuationJson(fence) || !saved || !saved.adminId.trim() ||
      continuationJson(saved) !== continuationJson(request) || saved.pauseId !== record.pause.id || !record.pause.hookId || !record.pause.registrationEventId) return result("blocked");
  // A false/ambiguous prior claim never dispatches again, even after a timeout.
  if (!await repository.claimDispatch(fence, request.key)) return result("not_dispatched");
  let state: "delivered" | "uncertain" | "blocked";
  try { const response = await resume(record.pause.token, saved.command); state = response.runId === fence.runId ? "delivered" : "blocked"; }
  catch { state = "uncertain"; }
  try { await repository.observeDispatch(fence, request.key, state); }
  catch {
    try {
      const current = await repository.read(fence.caseId);
      if (current?.requests.find(candidate => candidate.key === request.key)?.state === "accepted") return result("accepted");
    } catch { /* Lost response cannot permit another dispatch. */ }
    return result("uncertain");
  }
  return result(state);
}
