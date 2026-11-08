import type { ContinuationReservation, ContinuationStartOutcome, ContinuationStartResult } from "../domain/continuation.ts";

export interface ContinuationStartRepository {
  claim(caseId: string, reservation: ContinuationReservation): Promise<boolean>;
  observe(caseId: string, reservation: ContinuationReservation, outcome: ContinuationStartOutcome): Promise<void>;
  // Atomically compares durable start evidence with first-step registration.
  // Registration alone, including a late registration, never authorizes effects.
  reconcile(caseId: string, reservation: ContinuationReservation): Promise<ContinuationStartResult>;
}

// Storage protocol only; no live continuation entry point invokes this.
export async function reconcileContinuationStart(caseId: string, reservation: ContinuationReservation, repository: ContinuationStartRepository, start: (reservation: ContinuationReservation) => Promise<{ runId: string }>): Promise<ContinuationStartResult> {
  if (!await repository.claim(caseId, reservation)) return repository.reconcile(caseId, reservation);
  let outcome: ContinuationStartOutcome;
  try {
    const response = await start(reservation);
    if (!response.runId?.trim()) throw new Error("Missing start run ID");
    outcome = { state: "returned", runId: response.runId };
  } catch { outcome = { state: "lost" }; }
  // Failure/response loss here also cannot grant a second start claim.
  await repository.observe(caseId, reservation, outcome);
  return repository.reconcile(caseId, reservation);
}
