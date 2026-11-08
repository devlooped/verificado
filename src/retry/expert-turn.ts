import { z } from "zod";
import { generateText, jsonSchema, Output, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { seatOf } from "../court/turns.ts";
import { courtMaxOutputTokens, courtOutputPhase } from "../court/models.ts";
import type { CourtEvent } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import { CourtActionSchemas, modelFacingEvents, turnPhase, typedDecision } from "../instruction/court-tools.ts";
import { RetryBeforeEffectFailure } from "./execute.ts";
import type { RetryExpertTask, RetryExpertWork } from "./expert-procedure.ts";

const rawSchema = z.strictObject({ at: z.iso.datetime(), text: z.string(), messages: z.array(z.json()), usage: z.json(),
  toolCalls: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1), input: z.json() })).max(32), output: z.json() });
const toolSchema = z.strictObject({ at: z.iso.datetime(), output: z.json(), events: z.array(z.json()), done: z.boolean() });
const budgetSchema = z.strictObject({ expiresAt: z.iso.datetime(), maxCalls: z.number().int().min(1).max(20), timeoutMs: z.number().int().min(1).max(240_000) });
const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const reject = (): never => { throw new Error("Expert turn evidence rejected"); };
const prose = new Set(["text", "quote", "reason", "grounds", "rationale", "reasoning", "supporting", "opposing", "commentary"]);

function proseInputs(value: unknown, name: string, path: (string | number)[] = []): { path: (string | number)[]; text: string }[] {
  if (typeof value === "string") return prose.has(String(path.at(-1))) && !(name === "file_instruction" && path[0] === "proposals" && path.at(-1) === "quote") ? [{ path, text: value }] : [];
  if (Array.isArray(value)) return value.flatMap((child, index) => proseInputs(child, name, [...path, index]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => proseInputs(child, name, [...path, key]));
  return [];
}

function result(record: RetryRecord, spec: RetryUnitSpec): unknown | undefined {
  const matches = record.units.filter(unit => unit.key === spec.key), unit = matches[0];
  if (matches.length > 1) return reject();
  if (!unit) return undefined;
  const actual = { key: unit.key, kind: unit.kind, format: unit.format, dependencies: unit.dependencies,
    effect: unit.effect, estimatedCost: unit.estimatedCost, input: unit.input };
  if (!same(actual, spec) || unit.inputHash !== continuationHash(spec.input)) return reject();
  if (unit.state !== "ready") return undefined;
  if (unit.result === undefined || unit.resultHash !== continuationHash(unit.result)) return reject();
  return unit.result;
}

// Turns are decomposed here, not hidden in an external whole-seat unit. Both
// channels use creation-time prose/options/tools/budgets and the exact pinned
// record. A ready generation is read back before ANY returned tool dispatch.
export function nextRetryExpertTurnWork(record: RetryRecord, task: RetryExpertTask): RetryExpertWork {
  try { return plan(record, task); }
  catch { return { state: "blocked", reason: "expert_turn_evidence_invalid" }; }
}
function plan(record: RetryRecord, task: RetryExpertTask): RetryExpertWork {
  if (task.kind !== "turn" || !record.contract || !record.fence) return { state: "blocked", reason: "expert_effect_adapter_unavailable" };
  const config = record.contract.configuration, seat = seatOf(task.spec), phase = turnPhase(task.spec);
  const model = config.models[seat === "judge" ? "judge" : `counsel.${seat}`];
  const taskPrompt = config.prompts[`expert.task.${task.spec.kind}`];
  if (typeof taskPrompt !== "string" || model === undefined) return reject();
  const base = { configurationHash: record.contract.configurationHash, submission: config.submission, task, model, language: config.language,
    today: config.today, automaticRetries: config.automaticRetries };
  const spec = (suffix: string, kind: string, payload: unknown, dependencies: string[], pure = false): RetryUnitSpec => ({
    key: `${task.key}/${suffix}`, kind, format: 1, effect: pure ? "pure" : "external", estimatedCost: null, dependencies,
    input: { ...base, payload },
  });
  // Keep the logical phase conversations between turns, without reopening the
  // legacy runtime. Completed snapshots are chained to all their primitives.
  const completionIndex = record.units.findIndex(unit => unit.key === `${task.key}/complete`);
  const earlier = record.units.slice(0, completionIndex < 0 ? undefined : completionIndex).filter(unit => {
    if (unit.kind !== "expert.turn.completed") return false;
    const old = (unit.input as { task: RetryExpertTask }).task;
    return old.kind === "turn" && old.key !== task.key && seatOf(old.spec) === seat && turnPhase(old.spec) === phase;
  });
  const previous = earlier.at(-1);
  let conversations: Record<"preparation" | "decision", unknown[]> = { preparation: [], decision: [] }, previousCursor = 0;
  if (previous) {
    const old = previous.input as typeof base & { payload: { conversations: typeof conversations; cursor: number } };
    if (previous.state !== "ready" || previous.effect !== "pure" || previous.format !== 1 || !previous.owner ||
      previous.inputHash !== continuationHash(previous.input) || previous.resultHash !== continuationHash(previous.result) ||
      !same(previous.result, { status: "complete" }) || old.configurationHash !== base.configurationHash ||
      !same(old.model, model) || !Number.isSafeInteger(old.payload.cursor) || old.payload.cursor > task.record.length ||
      !same(old.task.record, task.record.slice(0, old.task.record.length))) return reject();
    conversations = structuredClone(old.payload.conversations); previousCursor = old.payload.cursor;
    if (![conversations.preparation, conversations.decision].every(messages => Array.isArray(messages) &&
      messages.length && same(messages[0], { role: "user", content: config.prompts[`expert.initial.${phase}:${seat}:${messages === conversations.preparation ? "preparation" : "decision"}`] }))) return reject();
  }
  const pin = spec("pin", "expert.turn.input", { taskPrompt, record: task.record, previousCursor }, previous ? [previous.key] : [], true);
  const pinned = result(record, pin);
  if (pinned === undefined) return { state: "pending", units: [pin] };
  if (!same(pinned, { status: "pinned" })) return reject();
  const dependencies = [pin.key], events: CourtEvent[] = [];
  const typed = phase === "instruction" || phase === "criticism" ? typedDecision(phase, task.record) : undefined;
  let draft = "", done = false;
  for (const channel of ["preparation", "decision"] as const) {
    const key = `${phase}:${seat}:${channel}`;
    const initial = config.prompts[`expert.initial.${key}`], system = config.prompts[`expert.system.${key}`], tools = config.tools[`expert.${key}`];
    const budget = budgetSchema.parse(config.budgets[`expert.${key}`]);
    if (typeof initial !== "string" || typeof system !== "string" || tools === undefined) return reject();
    const cutoff = phase === "debate" ? task.record.find(event => event.type === "instruction_closed")?.seq : 0;
    if (cutoff === undefined) return reject();
    const messages: unknown[] = [...(conversations[channel].length ? conversations[channel] : [{ role: "user", content: initial }]), { role: "user", content: JSON.stringify({
      events: modelFacingEvents(task.record.filter(event => event.seq > Math.max(cutoff, previousCursor))), task: `${JSON.stringify(task.spec)}\n${taskPrompt}`,
      ...(channel === "decision" ? { preparation: draft } : {}),
    }) }];
    for (let step = 0; step < budget.maxCalls && !done; step++) {
      const mode = channel === "decision" && typed ? step === 0 ? "reasoning" : "typed" : "tools";
      // Zod attaches a non-enumerable ~standard validator. Persist only the
      // JSON Schema document, never that executable SDK metadata.
      const outputSchema = mode === "typed" ? JSON.parse(JSON.stringify(z.toJSONSchema(typed!.schema, { target: "draft-7" }))) : null;
      const generation = spec(`${channel}/${step}/generation`, "expert.turn.generation",
        { channel, mode, system, initial, messages: structuredClone(messages), tools, budget, outputSchema }, [...dependencies]);
      const raw = result(record, generation);
      if (raw === undefined) return { state: "pending", units: [generation] };
      const generated = rawSchema.parse(raw);
      if (!same(generated, raw) || new Set(generated.toolCalls.map(call => call.id)).size !== generated.toolCalls.length) return reject();
      dependencies.push(generation.key);
      // The SDK adapter supplies assistant messages only: no hidden tool
      // execution/results can precede the corresponding durable tool intent.
      if (generated.messages.some(message => !message || typeof message !== "object" || Array.isArray(message) || message.role !== "assistant")) return reject();
      messages.push(...generated.messages);
      if (mode === "reasoning") { messages.push({ role: "user", content: typed!.request }); continue; }
      const filing = mode === "typed" ? typed!.input(generated.output) : undefined;
      const calls = filing ? [{ id: `answer-${step}`, name: typed!.action, input: filing.input }] : generated.toolCalls;
      for (const call of calls) {
        const court = Object.hasOwn(CourtActionSchemas, call.name);
        if (court && channel !== "decision") return reject();
        const prepared = JSON.parse(continuationJson(call.input));
        // Translation/normalization can call a model. Each individual prose
        // value has its OWN durable intent/result before the local court action.
        for (const item of court ? proseInputs(prepared, call.name) : []) {
          const normalization = spec(`${channel}/${step}/normalize/${continuationHash([call.id, item.path])}`, "expert.turn.normalize",
            { channel, call, ...item }, [...dependencies]);
          const normalized = result(record, normalization);
          if (normalized === undefined) return { state: "pending", units: [normalization] };
          const parsed = z.strictObject({ body: z.string() }).parse(normalized);
          if (!same(parsed, normalized)) return reject();
          dependencies.push(normalization.key);
          let target = prepared;
          for (const key of item.path.slice(0, -1)) target = target[key];
          target[item.path.at(-1)!] = parsed.body;
        }
        const tool = spec(`${channel}/${step}/tool/${continuationHash(call.id)}`, "expert.turn.tool",
          { channel, call: { ...call, input: prepared }, events: structuredClone(events), completed: done,
            dropped: filing?.dropped ?? [], generation: generation.key }, [...dependencies], court);
        const rawResult = result(record, tool);
        if (rawResult === undefined) return { state: "pending", units: [tool] };
        const applied = toolSchema.parse(rawResult);
        if (!same(applied, rawResult) || applied.events.some(event => !event || typeof event !== "object" || Array.isArray(event) ||
          typeof event.type !== "string" || !z.iso.datetime().safeParse(event.at).success)) return reject();
        dependencies.push(tool.key);
        events.push(...applied.events as unknown as CourtEvent[]);
        done ||= channel === "decision" && applied.done;
        messages.push(mode === "typed" ? { role: "user", content: JSON.stringify(applied.output) } : { role: "tool", content: [{
          type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "json", value: applied.output },
        }] });
      }
      if (channel === "preparation") { draft += generated.text; if (!calls.length) break; }
    }
    if (JSON.stringify(messages).length > 2_000_000) return reject();
    conversations[channel] = messages;
  }
  const completed = spec("complete", "expert.turn.completed", { conversations, cursor: task.record.length, events, done }, dependencies, true);
  const completedResult = result(record, completed);
  if (completedResult === undefined) return { state: "pending", units: [completed] };
  if (!same(completedResult, { status: "complete" })) return reject();
  return { state: "complete", events: events as unknown as Extract<RetryExpertWork, { state: "complete" }>["events"], done, units: [completed.key] };
}

// ONE provider dispatch. Tools are declarations, with no execute callbacks;
// server-native tools need a separately audited adapter, never a JSON fallback.
export async function generateRetryExpertText(spec: RetryUnitSpec, model: LanguageModel): Promise<unknown> {
  if (spec.kind !== "expert.turn.generation" || spec.effect !== "external") return reject();
  const input = spec.input as { task: Extract<RetryExpertTask, { kind: "turn" }>; model: { id: string; providerOptions?: Parameters<typeof generateText>[0]["providerOptions"] };
    payload: { system: string; messages: ModelMessage[]; mode: string; tools: unknown; budget: unknown; outputSchema: unknown } };
  const budget = budgetSchema.parse(input.payload.budget);
  const remaining = Date.parse(budget.expiresAt) - Date.now();
  // A spent original budget is not renewed by an admin request.
  if (remaining <= 0) throw new Error("Expert original budget expired");
  const tools: ToolSet = {};
  if (input.payload.mode === "tools") {
    const definitions = z.record(z.string(), z.strictObject({ description: z.string(), inputSchema: z.record(z.string(), z.json()) })).safeParse(input.payload.tools);
    if (!definitions.success) throw new RetryBeforeEffectFailure("expert_provider_tool_adapter_unavailable");
    for (const [name, definition] of Object.entries(definitions.data)) tools[name] = { description: definition.description, inputSchema: jsonSchema(definition.inputSchema) };
  }
  const generated = await generateText({ model, system: input.payload.system,
    messages: input.payload.messages, providerOptions: input.model.providerOptions, maxOutputTokens: courtMaxOutputTokens(courtOutputPhase(turnPhase(input.task.spec))), maxRetries: 0, stopWhen: stepCountIs(1),
    abortSignal: AbortSignal.timeout(Math.min(remaining, budget.timeoutMs)),
    ...(input.payload.mode === "typed" ? { output: Output.object({ schema: jsonSchema(input.payload.outputSchema as Record<string, unknown>) }) } :
      input.payload.mode === "tools" && Object.keys(tools).length ? { tools } : {}),
  });
  // Optional SDK fields use undefined; the durable representation is its JSON
  // wire data. Do not read output's throwing getter on an unstructured call.
  return JSON.parse(JSON.stringify({ at: new Date().toISOString(), text: generated.text, messages: generated.responseMessages, usage: generated.usage,
    toolCalls: generated.toolCalls.map(call => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
    output: input.payload.mode === "typed" ? generated.output : null }));
}

export async function performRetryExpertInputPin(spec: RetryUnitSpec): Promise<unknown> {
  if (!["expert.turn.input", "expert.turn.completed"].includes(spec.kind) || spec.effect !== "pure") return reject();
  return { status: spec.kind === "expert.turn.input" ? "pinned" : "complete" };
}
