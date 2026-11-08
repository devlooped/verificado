import { z } from "zod";
import { COUNSEL, majority, project, type Counsel, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import type { TurnOutcome, TurnSpec } from "../court/turns.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import type { RetryQuickPlan } from "./quick.ts";
import { nextRetryExpertTurnWork } from "./expert-turn.ts";

// A work planner exposes one generation/tool/object operation at a time, NEVER
// an opaque play(), collect(), settle() or runProcedure() effect. Its completed
// output must be anchored to every primitive result it consumed.
export type RetryExpertWork = { state: "pending"; units: RetryUnitSpec[] } |
  { state: "complete"; events: TurnOutcome["events"]; done: boolean; units: string[] } |
  { state: "blocked"; reason: string };
export type RetryExpertTask = { key: string; kind: "turn"; spec: TurnSpec; attempt: number; record: RecordedEvent[] } |
  { key: string; kind: "sources" | "settle" | "post"; record: RecordedEvent[] };
export type RetryExpertWorkPlanner = (record: RetryRecord, task: RetryExpertTask) => RetryExpertWork;

const cursorSchema = z.strictObject({
  format: z.literal(1), profile: z.literal("expert-procedure"), configurationHash: z.string(),
  stage: z.enum(["intake", "instruction", "sources", "review", "review-decisions", "settle", "floor", "objections", "reply", "ruling",
    "closing", "judgments", "tiebreak", "content", "content-judgment", "content-tiebreak", "summary", "close", "post", "finish"]),
  debate: z.enum(["opening", "rebuttal"]), counsel: z.number().int().min(0).max(4),
  objections: z.array(z.string()), objection: z.number().int().nonnegative(), statementId: z.string(),
  events: z.array(z.json()), dependencies: z.array(z.string()), checkpoint: z.string(),
});
type Cursor = z.infer<typeof cursorSchema>;
const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const reject = (): never => { throw new Error("expert_procedure_evidence_invalid"); };

function ready(record: RetryRecord, spec: RetryUnitSpec): unknown | undefined {
  const matches = record.units.filter(unit => unit.key === spec.key);
  if (matches.length > 1) return reject();
  const unit = matches[0];
  if (!unit) return undefined;
  const actual = { key: unit.key, kind: unit.kind, format: unit.format, dependencies: unit.dependencies,
    effect: unit.effect, estimatedCost: unit.estimatedCost, input: unit.input };
  if (!same(spec, actual) || unit.inputHash !== continuationHash(spec.input)) return reject();
  if (unit.state !== "ready") return undefined;
  if (unit.result === undefined || unit.resultHash !== continuationHash(unit.result)) return reject();
  return unit.result;
}
function verifyDependencies(record: RetryRecord, keys: string[], visiting = new Set<string>(), visited = new Set<string>()): void {
  for (const key of keys) {
    if (visited.has(key)) continue;
    if (visiting.has(key) || visited.size + visiting.size > 10_000) return reject();
    const matches = record.units.filter(unit => unit.key === key), unit = matches[0];
    if (matches.length !== 1 || !unit || unit.state !== "ready" || unit.inputHash !== continuationHash(unit.input) ||
      unit.result === undefined || unit.resultHash !== continuationHash(unit.result) || !unit.owner ||
      !Number.isSafeInteger(unit.attempt) || unit.attempt < 0 || unit.attempt > record.fence!.attempt ||
      !Number.isSafeInteger(unit.epoch) || unit.epoch < 0 || unit.epoch > record.fence!.epoch ||
      new Set(unit.dependencies).size !== unit.dependencies.length) return reject();
    visiting.add(key); verifyDependencies(record, unit.dependencies, visiting, visited); visiting.delete(key); visited.add(key);
  }
}
function marker(record: RetryRecord, body: Omit<Cursor, "checkpoint">): RetryUnitSpec {
  const input = { caseId: record.fence!.caseId, runId: record.fence!.runId, body };
  return { key: `expert/procedure/${continuationHash(input)}`, kind: "expert.procedure.checkpoint", format: 1,
    dependencies: body.dependencies, effect: "pure", estimatedCost: null, input };
}

export function nextRetryExpertProcedurePlan(record: RetryRecord, work: RetryExpertWorkPlanner = nextRetryExpertTurnWork): RetryQuickPlan {
  try { return plan(record, work); }
  catch { return { state: "blocked", reason: "expert_procedure_evidence_invalid" }; }
}

function plan(record: RetryRecord, work: RetryExpertWorkPlanner): RetryQuickPlan {
  const contract = parseRetryContract(record.contract);
  if (!contract || !record.fence || record.state !== "active" || contract.configuration.check !== "expert" ||
    contract.creation.caseId !== record.fence.caseId || contract.binding.runId !== record.fence.runId ||
    !same(record.creation, (({ binding: _binding, ...creation }) => creation)(contract)) || !record.startClaimed ||
    !same(record.startCandidate, contract.binding) || !same(record.startObservation, { state: "returned", runId: contract.binding.runId })) return reject();
  const model = (role: string) => z.object({ id: z.string().min(1), effort: z.string().nullable() }).parse(contract.configuration.models[role]);
  const judge = model("judge"), counsel = Object.fromEntries(COUNSEL.map(seat => [seat, model(`counsel.${seat}`)])) as Record<Counsel, ReturnType<typeof model>>;
  let cursor: Cursor;
  if (record.cursor === null) {
    if (record.nextSeq !== 1 || record.units.some(unit => unit.key.startsWith("expert/") && unit.kind !== "expert.procedure.checkpoint")) return reject();
    cursor = { format: 1, profile: "expert-procedure", configurationHash: contract.configurationHash, stage: "intake",
      debate: "opening", counsel: 0, objections: [], objection: 0, statementId: "", events: [], dependencies: [], checkpoint: "" };
  } else {
    cursor = cursorSchema.parse(record.cursor);
    const { checkpoint, ...body } = cursor;
    const spec = marker(record, body);
    if (cursor.configurationHash !== contract.configurationHash || checkpoint !== spec.key ||
      !same(ready(record, spec), { status: "checkpointed" }) || cursor.events.length + 1 !== record.nextSeq ||
      cursor.events.some((event, index) => !event || typeof event !== "object" || Array.isArray(event) || event.seq !== index + 1) ||
      new Set(cursor.dependencies).size !== cursor.dependencies.length) return reject();
    verifyDependencies(record, [checkpoint]);
  }
  const history = cursor.events as unknown as RecordedEvent[];
  const boundary = (patch: Partial<Cursor>, added: (CourtEvent & { at?: string })[] = [], units: string[] = []): RetryQuickPlan => {
    const events = added.map((event, index) => ({ ...event, at: event.at ?? contract.creation.at, seq: record.nextSeq + index }) as RecordedEvent);
    const { checkpoint: _checkpoint, ...body } = { ...cursor, ...patch, events: [...history, ...events],
      dependencies: [...new Set([...cursor.dependencies, ...units])] };
    const snapshot = cursorSchema.omit({ checkpoint: true }).parse(JSON.parse(continuationJson(body)));
    const spec = marker(record, snapshot), result = ready(record, spec);
    if (result === undefined) return { state: "units", units: [spec] };
    if (!same(result, { status: "checkpointed" })) return reject();
    return { state: "boundary", boundary: { key: spec.key, expectedSeq: record.nextSeq, units: [spec.key, ...body.dependencies],
      events, cursor: { ...body, checkpoint: spec.key } } };
  };
  if (record.cursor === null) return boundary({}, [{ type: "session_opened", judgeModel: judge.id, judgeEffort: judge.effort,
    counselModels: Object.fromEntries(COUNSEL.map(seat => [seat, counsel[seat].id])) as Record<Counsel, string>,
    counselEfforts: Object.fromEntries(COUNSEL.map(seat => [seat, counsel[seat].effort])) as Record<Counsel, string | null> }]);

  // No retry of a whole round. Pending primitives from all seats are exposed;
  // the workflow driver starts/waits for every sibling before pausing/fencing.
  const round = (specs: TurnSpec[]): { outcomes: TurnOutcome[]; units: string[] } | RetryQuickPlan => {
    const pending: RetryUnitSpec[] = [], outcomes: TurnOutcome[] = [], units: string[] = [];
    let failure: string | undefined;
    for (const spec of specs) {
      const events: TurnOutcome["events"] = [];
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        const key = `expert/work/${continuationHash([cursor.checkpoint, spec, attempt])}`;
        const result = work(record, { key, kind: "turn", spec, attempt, record: [...history, ...events.map((event, index) => ({ ...event, seq: history.length + index + 1 }))] });
        if (result.state === "blocked") { failure ??= result.reason; break; }
        if (result.state === "pending") { pending.push(...result.units); break; }
        if (!result.units.length) return reject();
        verifyDependencies(record, result.units);
        events.push(...result.events); units.push(...result.units); done = result.done;
      }
      outcomes.push({ events, done });
    }
    if (failure) return { state: "blocked", reason: failure };
    if (pending.length) {
      const unique = new Map<string, RetryUnitSpec>();
      for (const unit of pending) {
        if (unique.has(unit.key) && !same(unique.get(unit.key), unit)) return reject();
        unique.set(unit.key, unit);
      }
      return { state: "units", units: [...unique.values()] };
    }
    return { outcomes, units: [...new Set(units)] };
  };
  const absorb = (outcomes: TurnOutcome[]): TurnOutcome["events"] => {
    const added: TurnOutcome["events"] = [];
    let evidence = history.filter(event => event.type === "evidence_filed").length;
    let objections = history.filter(event => event.type === "objection").length;
    for (const outcome of outcomes) {
      const renamed = new Map<string, string>();
      for (const event of outcome.events) {
        if (event.type === "evidence_filed") {
          const id = `P${++evidence}`; renamed.set(event.evidence.id, id); added.push({ ...event, evidence: { ...event.evidence, id } });
        } else if (event.type === "objection") {
          const id = `O${++objections}`; renamed.set(event.id, id); added.push({ ...event, id });
        } else if (event.type === "statement") added.push({ ...event, evidenceIds: event.evidenceIds.map(id => renamed.get(id) ?? id) });
        else added.push(event);
      }
    }
    return added;
  };
  const absent = (by: Counsel, stage: Extract<CourtEvent, { type: "absence" }>["stage"]): CourtEvent => ({ type: "absence", by, stage });
  const run = (specs: TurnSpec[], next: Partial<Cursor>, absence?: Extract<CourtEvent, { type: "absence" }>["stage"], required = false): RetryQuickPlan => {
    const results = round(specs);
    if ("state" in results) return results;
    if (required && results.outcomes.some(outcome => !outcome.done)) return { state: "blocked", reason: "expert_required_turn_incomplete" };
    const added: (CourtEvent & { at?: string })[] = absorb(results.outcomes);
    if (absence) for (const [index, outcome] of results.outcomes.entries()) if (!outcome.done) {
      const spec = specs[index], seat = "counsel" in spec ? spec.counsel : "speaker" in spec ? spec.speaker : undefined;
      if (seat && !(spec.kind === "closing" && [...history, ...added].some(event => event.type === "vote" && event.by === seat))) added.push(absent(seat, absence));
    }
    return boundary(next, added, results.units);
  };
  const auxiliary = (kind: "sources" | "settle" | "post", next: Cursor["stage"]): RetryQuickPlan => {
    const result = work(record, { key: `expert/work/${continuationHash([cursor.checkpoint, kind])}`, kind, record: history });
    if (result.state === "blocked") return result;
    if (result.state === "pending") return { state: "units", units: result.units };
    if (!result.done || !result.units.length) return reject();
    verifyDependencies(record, result.units);
    if (kind === "settle" && (result.events.length !== 1 || result.events[0].type !== "evidence_settled")) return reject();
    if (kind === "post" && result.events.length) return reject();
    return boundary({ stage: next }, result.events, result.units);
  };
  const speaker = COUNSEL[cursor.counsel];
  switch (cursor.stage) {
    case "intake": {
      const results = round([{ kind: "intake" }]);
      if ("state" in results) return results;
      if (!results.outcomes[0].done) return { state: "blocked", reason: "expert_required_turn_incomplete" };
      const events = absorb(results.outcomes);
      if (!events.some(event => event.type === "claims_entered" || event.type === "dismissed")) return reject();
      return boundary({ stage: events.some(event => event.type === "dismissed") ? "close" : "instruction" }, events, results.units);
    }
    case "instruction":
      if (!history.some(event => event.type === "instruction_opened")) return boundary({}, [{ type: "instruction_opened" }]);
      return run(COUNSEL.map(counsel => ({ kind: "instruction", counsel })), { stage: "sources" }, "instruction");
    case "sources": return auxiliary("sources", "review");
    case "review": {
      if (!project(history).sources.size) return boundary({ stage: "settle" });
      return run(COUNSEL.map(counsel => ({ kind: "source_review", counsel })), { stage: "review-decisions" }, "source_review");
    }
    case "review-decisions": {
      return boundary({ stage: "settle" }, [...project(history).sources.values()].map(source => ({ type: "source_decided", sourceId: source.id,
        excluded: COUNSEL.filter(seat => source.votes[seat]?.veto).length > COUNSEL.length / 2 })));
    }
    case "settle":
      if (!history.some(event => event.type === "evidence_settled")) return auxiliary("settle", "settle");
      return boundary({ stage: "floor" }, [{ type: "instruction_closed" }]);
    case "floor": {
      if (!speaker) return boundary(cursor.debate === "opening" ? { debate: "rebuttal", counsel: 0 } : { stage: "closing", counsel: 0 });
      const floor = history.at(-1);
      if (floor?.type !== "floor_granted" || floor.to !== speaker || floor.stage !== cursor.debate) return boundary({}, [{ type: "floor_granted", to: speaker, stage: cursor.debate }]);
      return run([{ kind: "statement", counsel: speaker, stage: cursor.debate }], { stage: "objections" }, cursor.debate);
    }
    case "objections": {
      if (!speaker) return reject();
      const statement = history.find(event => event.type === "statement" && event.by === speaker && event.stage === cursor.debate);
      if (statement?.type !== "statement") return boundary({ stage: "floor", counsel: cursor.counsel + 1 });
      const results = round(COUNSEL.filter(counsel => counsel !== speaker).map(counsel => ({ kind: "objection", counsel, speaker, statementId: statement.id })));
      if ("state" in results) return results;
      const added: (CourtEvent & { at?: string })[] = absorb(results.outcomes);
      for (const [index, ok] of results.outcomes.entries()) if (!ok.done) added.push(absent(COUNSEL.filter(counsel => counsel !== speaker)[index], "objection"));
      return boundary({ stage: "reply", statementId: statement.id, objections: added.flatMap(event => event.type === "objection" ? [event.id] : []), objection: 0 }, added, results.units);
    }
    case "reply": {
      if (!speaker) return reject();
      const id = cursor.objections[cursor.objection];
      if (!id) return boundary({ stage: "floor", counsel: cursor.counsel + 1, objections: [], objection: 0, statementId: "" });
      const objection = history.find(event => event.type === "objection" && event.id === id);
      if (objection?.type !== "objection" || objection.against !== cursor.statementId) return reject();
      return run([{ kind: "reply", speaker, objector: objection.by, objectionId: id }], { stage: "ruling" }, "objection");
    }
    case "ruling": return run([{ kind: "ruling", objectionId: cursor.objections[cursor.objection] }], { stage: "reply", objection: cursor.objection + 1 }, undefined, true);
    case "closing": {
      if (!speaker) return boundary({ stage: "judgments" });
      const floor = history.at(-1);
      if (floor?.type !== "floor_granted" || floor.to !== speaker || floor.stage !== "closing") return boundary({}, [{ type: "floor_granted", to: speaker, stage: "closing" }]);
      return run([{ kind: "closing", counsel: speaker }], { counsel: cursor.counsel + 1 }, "closing");
    }
    case "judgments": return boundary({ stage: "tiebreak" }, history.flatMap(event => event.type === "claims_entered" ? event.claims : []).flatMap(claim => {
      const verdict = majority(history.flatMap(event => event.type === "vote" && event.claimId === claim.id ? [event.verdict] : []));
      return verdict ? [{ type: "judgment" as const, claimId: claim.id, verdict, method: "consensus" as const, reasoning: "" }] : [];
    }));
    case "tiebreak":
      if (history.flatMap(event => event.type === "claims_entered" ? event.claims : []).some(claim => !history.some(event => event.type === "judgment" && event.claimId === claim.id))) return run([{ kind: "tiebreak" }], { stage: "content" }, undefined, true);
      return boundary({ stage: "content" });
    case "content": return run(COUNSEL.map(counsel => ({ kind: "content_vote", counsel })), { stage: "content-judgment" }, "content");
    case "content-judgment": {
      const votes = Object.values(project(history).contentVotes).flatMap(vote => vote?.verdict ? [vote.verdict] : []), verdict = majority(votes);
      return boundary({ stage: !verdict && votes.length >= 3 ? "content-tiebreak" : "summary" }, verdict ? [{ type: "content_judgment", verdict, method: "consensus", reasoning: "" }] : []);
    }
    case "content-tiebreak": return run([{ kind: "content_tiebreak" }], { stage: "summary" }, undefined, true);
    case "summary": return run([{ kind: "summary" }], { stage: "close" }, undefined, true);
    case "close": return boundary({ stage: "post" }, [{ type: "session_closed" }]);
    case "post": return auxiliary("post", "finish");
    case "finish": return { state: "finished" };
  }
}

export async function performRetryExpertCheckpoint(spec: RetryUnitSpec): Promise<unknown> {
  if (spec.kind !== "expert.procedure.checkpoint" || spec.effect !== "pure" || spec.key !== `expert/procedure/${continuationHash(spec.input)}`) return reject();
  return { status: "checkpointed" };
}
