import { continuationHash, continuationJson } from "../domain/continuation.ts";
import type { RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";

// Only an audited adapter's PRE-DISPATCH validation may throw this. Network
// errors/timeouts/cancellation must never be translated to it by a provider.
export class RetryBeforeEffectFailure extends Error {
  constructor(readonly reason: string) {
    super("Retry unit failed before dispatch");
    if (!/^[a-z][a-z0-9_]{0,95}$/.test(reason)) throw new Error("Invalid retry failure code");
  }
}
export type RetryUnitOutcome =
  | { state: "complete"; key: string; result: unknown; reused: boolean }
  | { state: "paused"; key: string; reason: string }
  | { state: "blocked"; key: string; reason: string };
type UnitRepository = Pick<RetryRepository, "claimUnit" | "completeUnit" | "failUnit" | "read">;

// This function belongs INSIDE one maxRetries=0 Workflow step, not around a
// whole seat/round. Each invocation covers exactly one audited subeffect.
export async function executeRecordedUnit(
  repository: UnitRepository,
  fence: RetryFence,
  spec: RetryUnitSpec,
  perform: (input: unknown) => Promise<unknown>,
): Promise<RetryUnitOutcome> {
  continuationJson(spec);
  const claim = await repository.claimUnit(fence, spec);
  if (claim.state === "blocked") {
    // A parallel sibling's failure is NOT authorized by another seat's retry.
    // Re-expose only our exact pre-dispatch proof; the repository will require
    // a separate persisted pause/admin request before granting its next claim.
    if (claim.reason === "proven_failed") {
      const record = await repository.read(fence.caseId);
      const stored = record?.units.find(unit => unit.key === spec.key);
      if (record?.state === "active" && continuationJson(record.fence) === continuationJson(fence) &&
          stored?.state === "proven_failed" && stored.inputHash === continuationHash(spec.input) &&
          stored.inputHash === continuationHash(stored.input) && stored.kind === spec.kind && stored.format === spec.format &&
          stored.effect === spec.effect && stored.estimatedCost === spec.estimatedCost &&
          continuationJson(stored.dependencies) === continuationJson(spec.dependencies) &&
          stored.inactivityProof === `not-dispatched:${stored.inputHash}` && stored.reason && /^[a-z][a-z0-9_]{0,95}$/.test(stored.reason)) {
        return { state: "paused", key: spec.key, reason: stored.reason };
      }
    }
    return { state: "blocked", key: spec.key, reason: claim.reason };
  }
  if (claim.state === "reused") {
    if (claim.unit.state !== "ready" || claim.unit.result === undefined ||
        claim.unit.inputHash !== continuationHash(spec.input) ||
        claim.unit.resultHash !== continuationHash(claim.unit.result)) {
      return { state: "blocked", key: spec.key, reason: "unit_result_unverified" };
    }
    return { state: "complete", key: spec.key, result: claim.unit.result, reused: true };
  }

  let result: unknown;
  try {
    result = await perform(structuredClone(spec.input));
    continuationJson(result); // No lossy/accessor/undefined result can be ready.
  } catch (error) {
    const beforeDispatch = error instanceof RetryBeforeEffectFailure;
    const safe = beforeDispatch || spec.effect === "pure";
    const reason = beforeDispatch ? error.reason : safe ? "pure_unit_failed" : "external_effect_uncertain";
    try {
      await repository.failUnit(fence, spec.key, claim.owner, {
        state: safe ? "proven_failed" : "uncertain", reason,
        ...(safe ? { inactivityProof: `${beforeDispatch ? "not-dispatched" : "pure"}:${continuationHash(spec.input)}` } : {}),
      });
    } catch { return { state: "blocked", key: spec.key, reason: "failure_record_uncertain" }; }
    // An ordinary pure-code defect is blocked, not promised fixable by a hook.
    return { state: beforeDispatch ? "paused" : "blocked", key: spec.key, reason };
  }

  try { await repository.completeUnit(fence, spec.key, claim.owner, result); }
  catch {
    // COMMIT/response loss is reconciled only with the exact durable result.
    // Never invoke perform again because completeUnit threw or a lease expired.
    try {
      const record = await repository.read(fence.caseId);
      const stored = record?.units.find(unit => unit.key === spec.key);
      if (record?.fence?.runId === fence.runId && record.fence.attempt === fence.attempt && record.fence.epoch === fence.epoch &&
          stored?.state === "ready" && stored.inputHash === continuationHash(spec.input) &&
          stored.resultHash === continuationHash(result) && stored.resultHash === continuationHash(stored.result)) {
        return { state: "complete", key: spec.key, result: stored.result, reused: true };
      }
      await repository.failUnit(fence, spec.key, claim.owner, { state: "uncertain", reason: "result_publication_uncertain" });
    } catch { /* Missing/stale evidence cannot grant an additional call. */ }
    return { state: "blocked", key: spec.key, reason: "result_publication_uncertain" };
  }
  return { state: "complete", key: spec.key, result, reused: false };
}

// Wait for ALL seats before choosing a pause/epoch change. A rejected sibling
// must not cause writers still in flight to lose their publication fence.
export async function executeRetryRound(units: readonly (() => Promise<RetryUnitOutcome>)[]): Promise<RetryUnitOutcome[]> {
  const results = await Promise.allSettled(units.map(unit => Promise.resolve().then(unit)));
  return results.map(result => result.status === "fulfilled" ? result.value :
    { state: "blocked", key: "round", reason: "unit_protocol_failed" });
}
