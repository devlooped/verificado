import type { CourtModel } from "../court/models.ts";
import { sharedPipeline, type CourtEvent } from "../domain/court.ts";
import type { SeatId } from "../court/turns.ts";
import type { ContinuationWriter } from "../domain/continuation.ts";

export type InstructionPhase = "intake" | "instruction" | "criticism" | "debate";
export type SandboxBinding = {
  writer?: ContinuationWriter;
  phase: InstructionPhase;
  seat: SeatId;
  sessionKey: string;
  phaseSessionId: string;
  expiresAt: string;
  revoked: boolean;
  model: CourtModel;
  gatewayTools: unknown[];
  // Output cap of the calls; absent: 4096. null: none, for pipeline 3 research,
  // whose report carries every quote.
  maxOutputTokens?: number | null;
  activeTurn?: { id: string; expiresAt: string; remainingRequests: number };
};

export function committedPhase(events: readonly CourtEvent[]): InstructionPhase | "settling" {
  if (events.some((event) => event.type === "instruction_closed")) return "debate";
  if (events.some((event) => event.type === "evidence_settled")) return "settling";
  if (events.some((event) => event.type === "evidence_unified")) return "criticism";
  if (events.some((event) => event.type === "instruction_opened")) return "instruction";
  return "intake";
}

export function authorizeSandboxBinding(binding: SandboxBinding, context: { phase: InstructionPhase | "settling"; status: string; pipelineVersion: number; phaseSessionId?: string; activeTurnId?: string; generation?: number; runId?: string; now?: number }): void {
  const now = context.now ?? Date.now();
  if ((binding.writer?.generation ?? 0) !== (context.generation ?? 0) ||
      (binding.writer && (!Number.isSafeInteger(binding.writer.generation) || binding.writer.generation < 1 || binding.writer.runId !== context.runId))) throw new Error("sandbox_forbidden");
  if (!sharedPipeline(context.pipelineVersion) || context.status !== "in_session" || binding.revoked ||
      !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= now ||
      binding.phase !== context.phase || !binding.activeTurn ||
      Date.parse(binding.activeTurn.expiresAt) <= now || !Number.isFinite(Date.parse(binding.activeTurn.expiresAt)) ||
      binding.activeTurn.remainingRequests <= 0 || context.phaseSessionId !== binding.phaseSessionId || context.activeTurnId !== binding.activeTurn.id) throw new Error("sandbox_forbidden");
}

export function assertToolCapability(phase: InstructionPhase, name: string): void {
  const allowed = phase === "debate" ? ["read_evidence"] : phase === "intake" ? ["read_source"] : ["read_source", "web_search", "x_search"];
  if (!allowed.includes(name)) throw new Error("tool_not_available_in_phase");
}
