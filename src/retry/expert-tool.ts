import type { RetryUnitSpec } from "../domain/retry-state.ts";
import { z } from "zod";
import { continuationJson } from "../domain/continuation.ts";
import type { RecordedEvent, Submission } from "../domain/court.ts";
import { planTurn, seatOf } from "../court/turns.ts";
import { Rejection } from "../court/toolset.ts";
import { CourtActionSchemas, phaseActions, turnPhase, validateCourtText } from "../instruction/court-tools.ts";
import { validateCorpusCitations, type SettledCorpus } from "../evidence/settled.ts";
import type { RetryExpertTask } from "./expert-procedure.ts";

// Local court application ONLY. No reader, translator, source acquisition,
// sandbox, file or legacy createCourtActions/run dispatcher is reachable.
// The caller supplies a corpus previously loaded/verified by a trusted adapter;
// that adapter's immutable-object/retention guarantees remain an enablement gate.
export async function performRetryExpertCourtTool(spec: RetryUnitSpec, corpus?: SettledCorpus): Promise<unknown> {
  continuationJson(spec);
  if (spec.kind !== "expert.turn.tool" || spec.effect !== "pure") throw new Error("Expert court tool rejected");
  const input = spec.input as { language: string; submission: Submission; task: Extract<RetryExpertTask, { kind: "turn" }>;
    payload: { channel: string; call: { name: string; input: unknown }; events: RecordedEvent[]; completed: boolean } };
  const { task, payload } = input, phase = turnPhase(task.spec), name = payload.call.name;
  const allowed = phaseActions(phase, seatOf(task.spec), true);
  if (task.kind !== "turn" || payload.channel !== "decision" || !allowed.some(action => action === name)) throw new Error("Expert action not allowed");
  // planTurn's pass/object/decide flags are closure-local. A durable completed
  // primitive replaces that closure across dispatches, including an eventless
  // pass. Later calls from the same generation must not reopen the decision.
  if (payload.completed) return { at: new Date().toISOString(), output: { error: "turn_already_completed" }, events: [], done: true };
  if (phase === "debate") {
    const settled = task.record.find(event => event.type === "evidence_settled");
    if (!corpus || settled?.type !== "evidence_settled" || corpus.manifestHash !== settled.manifestHash || corpus.manifest.language !== input.language) {
      throw new Error("Expert settled corpus unavailable");
    }
  }
  const plan = planTurn(task.spec, [...task.record, ...payload.events], input.submission, [], false, true);
  const tool = plan.tools[name];
  if (!tool || !Object.hasOwn(CourtActionSchemas, name)) throw new Error("Expert action not allowed");
  try {
    let prepared: unknown = CourtActionSchemas[name as keyof typeof CourtActionSchemas].parse(payload.call.input);
    let citations: string[] | undefined;
    if (corpus) {
      validateCourtText(corpus, prepared);
      if (name === "make_statement") {
        const statement = CourtActionSchemas.make_statement.parse(prepared);
        citations = statement.evidenceIds; validateCorpusCitations(corpus, citations);
        prepared = { ...statement, evidenceIds: citations.map(citation => /(?:^|\/)(E\d+)/.exec(citation)![1]) };
      }
    }
    const output = (tool.handle as (value: unknown) => string)(tool.schema.parse(prepared));
    if (citations) for (const event of plan.produced) if (event.type === "statement") event.evidenceIds = citations;
    return { at: new Date().toISOString(), output, events: plan.produced, done: plan.done() };
  } catch (error) {
    // Domain refusals are model feedback, never an uncertain external effect.
    if (!(error instanceof Rejection) && !(error instanceof z.ZodError)) throw error;
    return { at: new Date().toISOString(), output: { error: error instanceof Rejection ? error.message : "invalid_court_input" }, events: plan.produced, done: plan.done() };
  }
}
