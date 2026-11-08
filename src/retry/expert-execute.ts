import type { LanguageModel } from "ai";
import { continuationJson } from "../domain/continuation.ts";
import type { RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { executeRecordedUnit, type RetryUnitOutcome } from "./execute.ts";
import { nextRetryExpertProcedurePlan, performRetryExpertCheckpoint, type RetryExpertWorkPlanner } from "./expert-procedure.ts";
import { generateRetryExpertText, performRetryExpertInputPin } from "./expert-turn.ts";

// Deployment-owned adapters, never workflow input or admin command contents.
// No default gateway, legacy tool dispatcher, archive or cleanup is reachable.
// A tool adapter MUST expose just the primitive selected by the work planner.
export type RetryExpertEffectAdapters = {
  model?: (spec: RetryUnitSpec) => LanguageModel | Promise<LanguageModel>;
  normalize?: (spec: RetryUnitSpec) => Promise<{ body: string }>;
  tool?: (spec: RetryUnitSpec) => Promise<unknown>;
};

export async function executeRetryExpertUnit(repository: RetryRepository, fence: RetryFence, spec: RetryUnitSpec,
  adapters: RetryExpertEffectAdapters = {}, work?: RetryExpertWorkPlanner): Promise<RetryUnitOutcome> {
  const blocked = (reason: string): RetryUnitOutcome => ({ state: "blocked", key: spec.key, reason });
  let ready = false;
  const permitted = async () => {
    const record = await repository.read(fence.caseId);
    if (!record || continuationJson(record.fence) !== continuationJson(fence)) return false;
    const next = nextRetryExpertProcedurePlan(record, work);
    if (next.state === "blocked") return false;
    const stored = record.units.find(unit => unit.key === spec.key);
    if (stored?.state === "ready") {
      const actual = { key: stored.key, kind: stored.kind, format: stored.format, dependencies: stored.dependencies,
        effect: stored.effect, estimatedCost: stored.estimatedCost, input: stored.input };
      ready = continuationJson(actual) === continuationJson(spec);
      if (ready) return true; // claimUnit verifies its hashes; never dispatches.
    }
    return next.state === "units" && next.units.some(expected => continuationJson(expected) === continuationJson(spec));
  };
  try {
    if (!await permitted()) return blocked("expert_unit_not_planned");
    if (!ready && (spec.kind === "expert.turn.generation" && !adapters.model || spec.kind === "expert.turn.tool" && !adapters.tool ||
      spec.kind === "expert.turn.normalize" && !adapters.normalize)) {
      return blocked("expert_effect_adapter_unavailable");
    }
    if (!["expert.procedure.checkpoint", "expert.turn.input", "expert.turn.completed", "expert.turn.generation", "expert.turn.normalize", "expert.turn.tool"].includes(spec.kind)) {
      return blocked("expert_effect_adapter_unavailable");
    }
    return await executeRecordedUnit(repository, fence, spec, async () => {
      // Recheck after the transactional claim and before dispatch. Every result
      // still commits against that claim's owner/epoch, including pure markers.
      if (!await permitted()) throw new Error("Expert unit changed before dispatch");
      if (spec.kind === "expert.procedure.checkpoint") return performRetryExpertCheckpoint(spec);
      if (spec.kind === "expert.turn.input" || spec.kind === "expert.turn.completed") return performRetryExpertInputPin(spec);
      if (spec.kind === "expert.turn.generation") return generateRetryExpertText(spec, await adapters.model!(spec));
      if (spec.kind === "expert.turn.normalize") return adapters.normalize!(spec);
      return adapters.tool!(spec);
    });
  } catch { return blocked("expert_unit_protocol_uncertain"); }
}
