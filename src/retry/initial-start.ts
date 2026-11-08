import type { RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryStartObservation } from "../domain/retry-state.ts";

// Initial creation only. This cannot retry a terminal/historical case and has
// no reset/Re-run fallback. Its durable claim survives transport/storage loss.
export async function reconcileInitialRetryStart(
  repository: Pick<RetryRepository, "claimStart" | "observeStart" | "reconcileStart">,
  caseId: string,
  requestKey: string,
  start: () => Promise<{ runId: string }>,
): Promise<RetryFence | null> {
  if (!await repository.claimStart(caseId, requestKey)) return repository.reconcileStart(caseId, requestKey);
  let observation: RetryStartObservation;
  try {
    const run = await start();
    if (!run.runId.trim()) throw new Error("Initial run identity missing");
    observation = { state: "returned", runId: run.runId };
  } catch { observation = { state: "lost" }; }
  await repository.observeStart(caseId, requestKey, observation);
  return repository.reconcileStart(caseId, requestKey);
}
