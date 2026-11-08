import type { RetryFence } from "../domain/retry-contract.ts";
import type { RetryBoundary, RetryPause, RetryUnitSpec } from "../domain/retry-state.ts";
import type { RetryUnitOutcome } from "./execute.ts";
import type { RetryQuickPlan } from "./quick.ts";

// Function-valued dependencies are deployed steps/VM hooks, not serialized run
// input. Tests inject the same contract with isolated stores and the real SDK.
export interface RetryWorkflowSteps {
  load(fence: RetryFence): Promise<RetryQuickPlan>;
  execute(fence: RetryFence, spec: RetryUnitSpec): Promise<RetryUnitOutcome>;
  skip(fence: RetryFence, spec: RetryUnitSpec, reason: string): Promise<void>;
  publish(fence: RetryFence, boundary: RetryBoundary): Promise<void>;
  pause(fence: RetryFence, unitKey: string, reason: string): Promise<RetryPause>;
  confirm(fence: RetryFence, pause: RetryPause): Promise<void>;
  consume(fence: RetryFence, command: unknown): Promise<RetryFence | null>;
  block(fence: RetryFence, reason: string): Promise<void>;
  finish(fence: RetryFence): Promise<void>;
}
export interface RetryWorkflowHook extends AsyncIterable<unknown> {
  getConflict(): Promise<unknown>;
  [Symbol.dispose](): void;
}
export type RetryWorkflowResult = { state: "finished"; fence: RetryFence } | { state: "blocked"; reason: string };

// No start(), Re-run, reset, cancellation, timers or lease-based takeover here.
// A hook command is only a signal; consume() consults its durable authorization.
export async function driveRetryWorkflow(
  initialFence: RetryFence,
  steps: RetryWorkflowSteps,
  createHook: (token: string) => RetryWorkflowHook,
): Promise<RetryWorkflowResult> {
  let fence = initialFence;
  const blocked = async (reason: string): Promise<RetryWorkflowResult> => {
    try { await steps.block(fence, reason); } catch { /* Preserve any prior durable evidence; never force ownership. */ }
    return { state: "blocked", reason };
  };
  try {
    for (;;) {
      const next = await steps.load(fence);
      if (next.state === "blocked") return blocked(next.reason);
      if (next.state === "finished") { await steps.finish(fence); return { state: "finished", fence }; }
      if (next.state === "boundary") { await steps.publish(fence, next.boundary); continue; }
      if (next.state === "skip") { await steps.skip(fence, next.unit, next.reason); continue; }
      // Include synchronous adapter failures in settlement; a throw during map
      // must not prevent later seats from starting or fence out active siblings.
      const settled = await Promise.allSettled(next.units.map(spec => Promise.resolve().then(() => steps.execute(fence, spec))));
      const outcomes: RetryUnitOutcome[] = settled.map((outcome, i) => outcome.status === "fulfilled" ? outcome.value :
        { state: "blocked", key: next.units[i].key, reason: "unit_protocol_failed" });
      const unsafe = outcomes.find(outcome => outcome.state === "blocked");
      if (unsafe?.state === "blocked") return blocked(unsafe.reason);
      const recoverable = outcomes.find(outcome => outcome.state === "paused");
      if (recoverable?.state !== "paused") continue;
      const pause = await steps.pause(fence, recoverable.key, recoverable.reason);
      const hook = createHook(pause.token);
      try {
        // createHook alone is not registration. No durable paused/exposed state
        // is published until this registration suspension has completed.
        if (await hook.getConflict()) return blocked("hook_token_conflict");
        await steps.confirm(fence, pause);
        let accepted: RetryFence | null = null;
        for await (const command of hook) {
          accepted = await steps.consume(fence, command);
          if (accepted) break; // Duplicate/unknown commands authorize nothing.
        }
        if (!accepted) return blocked("hook_closed_without_authorization");
        if (accepted.caseId !== fence.caseId || accepted.runId !== fence.runId ||
            accepted.attempt !== fence.attempt + 1 || accepted.epoch !== fence.epoch + 1) return blocked("resume_fence_mismatch");
        fence = accepted;
      } catch { return blocked("hook_registration_or_delivery_uncertain"); }
      finally { hook[Symbol.dispose](); }
    }
  } catch { return blocked("retry_protocol_uncertain"); }
}
