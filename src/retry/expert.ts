import { z } from "zod";
import { COUNSEL, type Counsel, type RecordedEvent } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import type { RetryQuickPlan } from "./quick.ts";

// This is an offline protocol simulation, NOT an adapter for PhaseSession or
// advanceSharedTurn. It stops before source collection; it cannot finish a case.
// A real route must not use it even if a model happens to have a fixture name.
const cursorSchema = z.strictObject({
  format: z.literal(1), profile: z.literal("expert-simulation"),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(["intake", "instruction", "sources", "dismissed"]),
  events: z.array(z.json()), dependencies: z.array(z.string().min(1)), checkpoint: z.string().min(1),
});
type Cursor = z.infer<typeof cursorSchema>;
const prepSchema = z.strictObject({
  startedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), at: z.iso.datetime(),
  draft: z.string(), messages: z.array(z.json()), steps: z.number().int().nonnegative(),
});
const generationSchema = z.strictObject({
  at: z.iso.datetime(), messages: z.array(z.json()), usage: z.json(),
  toolCalls: z.array(z.strictObject({ id: z.string().min(1).max(128), name: z.string().min(1), input: z.json() })).max(16),
});
const claim = z.strictObject({ id: z.string().min(1), quote: z.string(), text: z.string().min(1) });
const proposed = z.strictObject({ claimId: z.string().min(1), url: z.url(), quote: z.string(),
  stance: z.enum(["supports", "opposes", "context"]), commentary: z.string().optional() });
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("claims_entered"), claims: z.array(claim).min(1), at: z.iso.datetime() }),
  z.strictObject({ type: z.literal("dismissed"), reason: z.string().min(1), at: z.iso.datetime() }),
  z.strictObject({ type: z.literal("evidence_proposed"), by: z.enum(COUNSEL), proposal: proposed, at: z.iso.datetime() }),
  z.strictObject({ type: z.literal("instruction_completed"), by: z.enum(COUNSEL), searches: z.array(z.strictObject({ claimId: z.string(), supporting: z.string(), opposing: z.string() })), at: z.iso.datetime() }),
]);
const toolSchema = z.strictObject({ at: z.iso.datetime(), output: z.json(), events: z.array(eventSchema), done: z.boolean() });
const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const invalid = (reason: string): never => { throw new Error(reason); };

function result(record: RetryRecord, spec: RetryUnitSpec): unknown | undefined {
  const matches = record.units.filter(unit => unit.key === spec.key);
  if (matches.length > 1) return invalid("expert_unit_unverified");
  const found = matches[0];
  if (!found) return undefined;
  const actual = { key: found.key, kind: found.kind, format: found.format, dependencies: found.dependencies,
    effect: found.effect, estimatedCost: found.estimatedCost, input: found.input };
  if (!same(actual, spec) || found.inputHash !== continuationHash(spec.input) || found.inputHash !== continuationHash(found.input)) return invalid("expert_unit_unverified");
  if (found.state === "skipped") {
    if (!found.reason?.trim() || found.result !== undefined || found.resultHash !== undefined) return invalid("expert_unit_unverified");
    return { skipped: found.reason };
  }
  if (found.state !== "ready") return undefined; // claimUnit decides whether this exact failed unit is authorized.
  if (found.result === undefined || found.resultHash !== continuationHash(found.result)) return invalid("expert_unit_unverified");
  return found.result;
}

function checkpoint(record: RetryRecord, value: Omit<Cursor, "checkpoint" | "events"> & { events: unknown[] }): RetryUnitSpec {
  const input = { ...value, caseId: record.fence!.caseId, runId: record.fence!.runId };
  return { key: `expert/checkpoint/${continuationHash(input)}`, kind: "expert.simulation.checkpoint", format: 1,
    dependencies: value.dependencies, effect: "pure", estimatedCost: null, input };
}

function verifyDependencies(record: RetryRecord, key: string, visited = new Set<string>(), active = new Set<string>()): void {
  if (visited.has(key)) return;
  if (active.has(key) || visited.size > 10_000) return invalid("expert_checkpoint_missing");
  const matches = record.units.filter(unit => unit.key === key);
  if (matches.length !== 1) return invalid("expert_checkpoint_missing");
  const unit = matches[0];
  if (!Number.isSafeInteger(unit.attempt) || !Number.isSafeInteger(unit.epoch) || unit.attempt < 0 || unit.epoch < 0 ||
      unit.attempt > record.fence!.attempt || unit.epoch > record.fence!.epoch ||
      unit.inputHash !== continuationHash(unit.input) || new Set(unit.dependencies).size !== unit.dependencies.length ||
      (unit.state === "ready" ? unit.result === undefined || unit.resultHash !== continuationHash(unit.result) :
        unit.state !== "skipped" || !unit.reason?.trim() || unit.result !== undefined || unit.resultHash !== undefined))
    return invalid("expert_checkpoint_missing");
  active.add(key);
  for (const dependency of unit.dependencies) verifyDependencies(record, dependency, visited, active);
  active.delete(key); visited.add(key);
}

// The cursor is anchored to a ready unit, including its whole event prefix and
// expected sequence. Missing/corrupt checkpoints cannot be treated as a start.
function checkedCursor(record: RetryRecord, configHash: string): Cursor {
  const current = cursorSchema.parse(record.cursor);
  const { checkpoint: key, ...body } = current;
  if (current.configurationHash !== configHash || current.events.length + 1 !== record.nextSeq ||
      current.events.some((event, i) => !event || typeof event !== "object" || Array.isArray(event) || event.seq !== i + 1) ||
      new Set(current.dependencies).size !== current.dependencies.length) return invalid("expert_cursor_invalid");
  const spec = checkpoint(record, body);
  const ready = result(record, spec);
  if (key !== spec.key || ready === undefined || !same(ready, { status: "checkpointed" })) return invalid("expert_checkpoint_missing");
  verifyDependencies(record, key);
  return current;
}

export function nextRetryExpertPlan(record: RetryRecord, options = { simulation: false }): RetryQuickPlan {
  try { return plan(record, options); }
  catch (error) {
    const reason = error instanceof Error && /^expert_[a-z_]+$/.test(error.message) ? error.message : "expert_evidence_invalid";
    return { state: "blocked", reason };
  }
}

function plan(record: RetryRecord, options: { simulation: boolean }): RetryQuickPlan {
  // No real provider adapters or nested-effect proofs exist yet.
  if (!options.simulation) return { state: "blocked", reason: "expert_live_effects_unverified" };
  const c = parseRetryContract(record.contract);
  if (!c || !record.fence || record.state !== "active" || c.configuration.check !== "expert" ||
      c.binding.world !== "fixture" || !c.binding.deploymentId.startsWith("fixture") ||
      record.fence.caseId !== c.creation.caseId || record.fence.runId !== c.binding.runId ||
      !Number.isSafeInteger(record.fence.attempt) || record.fence.attempt < 0 || !Number.isSafeInteger(record.fence.epoch) || record.fence.epoch < 0 ||
      !Number.isSafeInteger(record.nextSeq) || record.nextSeq < 1 ||
      !same(record.creation, (({ binding: _binding, ...creation }) => creation)(c)) ||
      !same(record.startCandidate, c.binding) || !same(record.startObservation, { state: "returned", runId: c.binding.runId }) || !record.startClaimed)
    return { state: "blocked", reason: "expert_contract_unverified" };
  const submission = c.configuration.submission;
  if (!submission || typeof submission !== "object" || Array.isArray(submission) || submission.check !== "expert" ||
      (submission.kind !== "text" && submission.kind !== "link")) return { state: "blocked", reason: "expert_submission_unverified" };
  const model = (role: string) => {
    const parsed = z.strictObject({ id: z.string().startsWith("fixture/"), effort: z.string().nullable(), providerOptions: z.json().optional() }).safeParse(c.configuration.models[role]);
    if (!parsed.success) return invalid("expert_snapshot_incomplete");
    return parsed.data;
  };
  const judge = model("judge");
  const seats = Object.fromEntries(COUNSEL.map(seat => [seat, model(`counsel.${seat}`)])) as Record<Counsel, ReturnType<typeof model>>;
  const boundary = (stage: Cursor["stage"], oldEvents: RecordedEvent[], added: RecordedEvent[], dependencies: string[]): RetryQuickPlan => {
    const body = { format: 1 as const, profile: "expert-simulation" as const, configurationHash: c.configurationHash,
      stage, events: [...oldEvents, ...added], dependencies };
    const marker = checkpoint(record, body);
    const ready = result(record, marker);
    if (ready === undefined) return { state: "units", units: [marker] };
    if (!same(ready, { status: "checkpointed" })) return invalid("expert_unit_unverified");
    return { state: "boundary", boundary: { key: marker.key, units: [marker.key, ...dependencies], expectedSeq: record.nextSeq,
      events: added, cursor: { ...body, checkpoint: marker.key } } };
  };
  if (record.cursor === null) {
    if (record.nextSeq !== 1 || record.units.some(unit => unit.key.startsWith("expert/") && unit.kind !== "expert.simulation.checkpoint")) return invalid("expert_checkpoint_missing");
    const event: RecordedEvent = { type: "session_opened", at: c.creation.at, seq: 1, simulated: true,
      judgeModel: judge.id, judgeEffort: judge.effort,
      counselModels: Object.fromEntries(COUNSEL.map(seat => [seat, seats[seat].id])) as Record<Counsel, string>,
      counselEfforts: Object.fromEntries(COUNSEL.map(seat => [seat, seats[seat].effort])) as Record<Counsel, string | null> };
    return boundary("intake", [], [event], []);
  }
  const current = checkedCursor(record, c.configurationHash);
  if (current.stage === "sources" || current.stage === "dismissed") return { state: "blocked", reason: "expert_simulation_remaining_procedure_unimplemented" };
  const history = current.events as RecordedEvent[];
  const specs: RetryUnitSpec[] = [];
  const skipped: Array<{ unit: RetryUnitSpec; reason: string }> = [];
  const completedKeys: string[] = [current.checkpoint];
  const outcomes: Array<{ seat: "judge" | Counsel; events: z.infer<typeof eventSchema>[]; done: boolean }> = [];
  const roles: Array<"judge" | Counsel> = current.stage === "intake" ? ["judge"] : [...COUNSEL];
  const make = (key: string, kind: string, dependencies: string[], seat: "judge" | Counsel, payload: unknown, effect: "pure" | "external" = "external"): RetryUnitSpec => {
    const prompt = c.configuration.prompts[kind];
    if (effect === "external" && typeof prompt !== "string") return invalid("expert_snapshot_incomplete");
    return { key, kind, format: 1, dependencies, effect, estimatedCost: null, input: {
      configurationHash: c.configurationHash, model: seat === "judge" ? judge : seats[seat], prompt: prompt ?? "",
      tools: c.configuration.tools, language: c.configuration.language, today: c.configuration.today,
      budgets: c.configuration.budgets, automaticRetries: c.configuration.automaticRetries, submission: c.configuration.submission, payload,
    } };
  };
  for (const seat of roles) {
    let previous: unknown[] = [], deps = [current.checkpoint], done = false;
    const events: z.infer<typeof eventSchema>[] = [];
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const root = `expert/${current.stage}/${seat}/${attempt}`;
      const base = { stage: current.stage, seat, attempt, history, previous };
      const prep = make(`${root}/preparation`, "expert.simulation.preparation", deps, seat, base);
      const rawPrep = result(record, prep);
      if (rawPrep === undefined) { specs.push(prep); break; }
      const prepared = prepSchema.parse(rawPrep);
      if (Date.parse(prepared.expiresAt) < Date.parse(prepared.startedAt) || Date.parse(prepared.at) < Date.parse(prepared.startedAt) ||
          Date.parse(prepared.at) > Date.parse(prepared.expiresAt)) return invalid("expert_result_invalid");
      const generation = make(`${root}/generation`, "expert.simulation.generation", [prep.key], seat, { ...base, preparation: prepared });
      const rawGeneration = result(record, generation);
      if (rawGeneration === undefined) { specs.push(generation); break; }
      const generated = generationSchema.parse(rawGeneration);
      if (Date.parse(generated.at) < Date.parse(prepared.startedAt) || Date.parse(generated.at) > Date.parse(prepared.expiresAt) ||
          new Set(generated.toolCalls.map(call => call.id)).size !== generated.toolCalls.length) return invalid("expert_result_invalid");
      const toolUnits = generated.toolCalls.map(call => make(`${root}/tool/${continuationHash(call.id)}`, "expert.simulation.tool", [generation.key], seat, { ...base, preparation: prepared, generation: generated, call }));
      if (!toolUnits.length) {
        const none = make(`${root}/tool/none`, "expert.simulation.no_tool", [generation.key], seat, base, "pure");
        const omitted = result(record, none);
        if (omitted === undefined) { skipped.push({ unit: none, reason: "simulation_no_tool_call" }); break; }
        if (!same(omitted, { skipped: "simulation_no_tool_call" })) return invalid("expert_result_invalid");
        completedKeys.push(prep.key, generation.key, none.key);
        previous = [...previous, { preparation: prepared, generation: generated, tools: [] }]; deps = [none.key];
        continue;
      }
      const missing = toolUnits.filter(unit => result(record, unit) === undefined);
      if (missing.length) { specs.push(...missing); break; }
      const tools = toolUnits.map(unit => toolSchema.parse(result(record, unit)));
      if (tools.slice(0, -1).some(tool => tool.done)) return invalid("expert_result_invalid");
      for (const tool of tools) {
        if (Date.parse(tool.at) < Date.parse(prepared.startedAt) || Date.parse(tool.at) > Date.parse(prepared.expiresAt)) return invalid("expert_result_invalid");
        for (const event of tool.events) {
          if (Date.parse(event.at) < Date.parse(prepared.startedAt) || Date.parse(event.at) > Date.parse(prepared.expiresAt)) return invalid("expert_result_invalid");
          if (current.stage === "intake" ? !["claims_entered", "dismissed"].includes(event.type) :
            !(event.type === "evidence_proposed" || event.type === "instruction_completed") || event.by !== seat) return invalid("expert_result_invalid");
          events.push(event);
        }
      }
      done = tools.some(tool => tool.done);
      completedKeys.push(prep.key, generation.key, ...toolUnits.map(unit => unit.key));
      previous = [...previous, { preparation: prepared, generation: generated, tools }]; deps = toolUnits.map(unit => unit.key);
    }
    if (!specs.some(spec => spec.key.startsWith(`expert/${current.stage}/${seat}/`)) && !skipped.some(item => item.unit.key.startsWith(`expert/${current.stage}/${seat}/`))) outcomes.push({ seat, events, done });
  }
  if (specs.length) return { state: "units", units: specs };
  if (skipped.length) return { state: "skip", ...skipped[0] };
  if (outcomes.length !== roles.length) return invalid("expert_result_invalid");
  if (current.stage === "intake") {
    const output = outcomes[0];
    if (!output.done || output.events.length !== 1) return invalid("expert_result_invalid");
    const event = output.events[0];
    if (event.type === "claims_entered" && new Set(event.claims.map(item => item.id)).size !== event.claims.length) return invalid("expert_result_invalid");
    const added = [{ ...event, seq: record.nextSeq }] as RecordedEvent[];
    if (event.type === "dismissed") return boundary("dismissed", history, added, completedKeys);
    added.push({ type: "instruction_opened", at: event.at, seq: record.nextSeq + 1 });
    return boundary("instruction", history, added, completedKeys);
  }
  const added: RecordedEvent[] = [];
  const claimIds = new Set(history.flatMap(event => event.type === "claims_entered" ? event.claims.map(item => item.id) : []));
  if (!claimIds.size) return invalid("expert_cursor_invalid");
  for (const outcome of outcomes) {
    if (outcome.done && !outcome.events.some(event => event.type === "instruction_completed")) return invalid("expert_result_invalid");
    for (const event of outcome.events) {
      if (event.type === "evidence_proposed" && !claimIds.has(event.proposal.claimId)) return invalid("expert_result_invalid");
      if (event.type === "instruction_completed" && event.searches.some(search => !claimIds.has(search.claimId))) return invalid("expert_result_invalid");
    }
    for (const event of outcome.events) added.push({ ...event, seq: record.nextSeq + added.length } as RecordedEvent);
    if (!outcome.done) added.push({ type: "absence", by: outcome.seat as Counsel, stage: "instruction", at: c.creation.at, seq: record.nextSeq + added.length });
  }
  return boundary("sources", history, added, completedKeys);
}

export async function performPureRetryExpertUnit(spec: RetryUnitSpec): Promise<unknown> {
  if (spec.kind === "expert.simulation.checkpoint" && spec.key.startsWith("expert/checkpoint/") && spec.effect === "pure") return { status: "checkpointed" };
  throw new Error("Expert simulation adapter unavailable");
}
