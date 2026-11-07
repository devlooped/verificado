import type { CheckType, CourtEvent } from "@/domain/court.ts";

// The stages of the method page, in the order the court goes through them.
export const PROGRESS_STEPS = ["Instrucción", "Fuentes", "Crítica de fuentes", "Debate", "Resultado"] as const;
const LEGACY_PROGRESS_STEPS = ["Instrucción", "Crítica de fuentes", "Debate", "Resultado"] as const;
// A Quick check: the analysts answer, then vote.
export const QUICK_PROGRESS_STEPS = ["Respuestas", "Resultado"] as const;
export const QUICK_CLAIMS_PROGRESS_STEPS = ["Afirmaciones", "Respuestas", "Resultado"] as const;

const STAGE_OF: Partial<Record<CourtEvent["type"], number>> = {
  source_collection_started: 1,
  source_batch_started: 1,
  source_batch_completed: 1,
  evidence_unified: 2,
  source_review_vote: 2,
  source_decided: 2,
  instruction_closed: 3,
  floor_granted: 3,
  statement: 3,
  objection: 3,
  objection_reply: 3,
  ruling: 3,
  vote: 4,
  judgment: 4,
  content_vote: 4,
  content_judgment: 4,
  case_summary: 4,
  session_closed: 4,
};

// The stage the court is in: the furthest one any recorded event belongs to.
export function sessionStage(events: readonly Pick<CourtEvent, "type">[]): number {
  return events.reduce((stage, e) => Math.max(stage, STAGE_OF[e.type] ?? 0), 0);
}

// A Quick check reaches its result with the first vote.
export function quickStage(events: readonly Pick<CourtEvent, "type">[], identifyClaims = false): number {
  if (!identifyClaims) return sessionStage(events) === 4 ? 1 : 0;
  return sessionStage(events) === 4 ? 2 : events.some((e) => e.type === "claims_entered") ? 1 : 0;
}

export function SessionProgress({ events, queued, check = "expert", collectionProgress = false, identifyClaims = false }: { events: readonly CourtEvent[]; queued: boolean; check?: CheckType; collectionProgress?: boolean; identifyClaims?: boolean }) {
  const quick = check === "quick";
  const steps: readonly string[] = quick ? identifyClaims ? QUICK_CLAIMS_PROGRESS_STEPS : QUICK_PROGRESS_STEPS : collectionProgress ? PROGRESS_STEPS : LEGACY_PROGRESS_STEPS;
  const stage = sessionStage(events);
  const current = queued ? -1 : quick ? quickStage(events, identifyClaims) : collectionProgress ? stage : Math.max(0, stage - 1);
  const claims = events.findLast((e) => e.type === "claims_entered")?.claims.length ?? 0;
  const collected = events.findLast((e) => e.type === "source_batch_completed");
  const collection = events.findLast((e) => e.type === "source_collection_started");
  return (
    <div className="mx-auto mt-10 max-w-xl text-left">
      <p className="sr-only" role="status">
        {queued ? "El caso está en espera." : "Etapa " + (current + 1) + " de " + steps.length + ": " + steps[current] + "."}
      </p>
      <ol className={"grid gap-2 " + (quick ? identifyClaims ? "grid-cols-3" : "grid-cols-2" : collectionProgress ? "grid-cols-5" : "grid-cols-4")} aria-label="Etapas del análisis">
        {steps.map((step, i) => {
          const state = i < current ? "done" : i === current ? "current" : "pending";
          return (
            <li key={step} aria-current={state === "current" ? "step" : undefined}>
              <span
                className={
                  "block h-1.5 rounded-full " +
                  (state === "done" ? "bg-ink" : state === "current" ? "session-light bg-seal" : "bg-rule")
                }
              />
              <span className={"mt-2 block text-xs " + (state === "pending" ? "text-ink-soft" : "font-medium text-ink")}>
                {step}
                <span className="sr-only">{state === "done" ? " (terminada)" : state === "current" ? " (en curso)" : " (pendiente)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-center text-sm text-ink-soft">
        {queued
          ? "El caso está en espera; el panel lo toma en un momento."
          : quick
            ? identifyClaims && current === 0 ? "El moderador está identificando las afirmaciones." : current === steps.length - 1 ? "Los analistas están votando." : "Los analistas están respondiendo."
          : collectionProgress && current === 1 && collection
            ? "Enlaces consultados: " + (collected?.completed ?? 0) + " de " + collection.total + "."
          : claims > 0
            ? claims + (claims === 1 ? " afirmación en estudio." : " afirmaciones en estudio.")
            : "El moderador está identificando las afirmaciones."}
      </p>
    </div>
  );
}
