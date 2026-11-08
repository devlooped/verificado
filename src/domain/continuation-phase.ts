import { types } from "node:util";
import { z } from "zod";
import { continuationHash, continuationJson, type ContinuationWriter } from "./continuation.ts";
import type { RecordedEvent } from "./court.ts";

const id = z.string().min(1).refine(value => value === value.trim());
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const at = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const turnSchema = z.object({ id, startedAt: at, expiresAt: at, start: integer.min(2), steps: integer,
  inFlightStep: id.optional(), preparationToolChoice: z.enum(["auto", "none"]).optional(),
  preparationCommand: z.object({ id, resultPath: id }).strict().optional(), preparationBound: z.boolean().optional(),
  timedOut: z.boolean().optional(), reasoned: z.boolean().optional(),
  answer: z.object({ step: integer, output: z.unknown().optional(), error: z.string().min(1).optional() }).strict().optional(),
  events: z.array(z.unknown()), done: z.boolean(), complete: z.boolean(), draft: z.string().optional(),
  results: z.record(z.string(), z.object({ input: z.string().min(1), output: z.unknown() }).strict()),
}).strict();
const bodySchema = z.object({ id, createdAt: at, phase: z.enum(["intake", "instruction", "criticism", "debate"]),
  seat: z.enum(["judge", "grok", "gemini", "claude", "chatgpt"]), channel: z.enum(["preparation", "decision"]),
  model: z.object({ id, providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict(),
  system: z.string(), tools: z.string(), messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown())]), providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict()).min(1),
  cursor: integer, turns: z.record(z.string(), turnSchema), activeTurn: turnSchema.optional(), sandboxId: id.optional(),
}).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), status: z.literal("blocked"), caseId: id,
  generation: integer.min(1), runId: id, deploymentId: id, pipeline: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  sessionKey: id, recordHash: hash, body: bodySchema,
}).strict();
export type ContinuationPhaseSnapshot = z.infer<typeof snapshotSchema>;

// Storage only, not a PhaseRepository or a ready/result validator. JSON is
// captured before awaiting DB; hooks, cycles and oversized candidates fail closed.
function json(value: unknown): string {
  let nodes = 0, characters = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error("Continuation phase JSON bounds exceeded");
    if (typeof item === "string") characters += item.length;
    if (item && typeof item === "object") {
      if (types.isProxy(item) || active.has(item)) throw new Error("Continuation phase requires plain acyclic JSON");
      active.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (typeof key !== "string" || !("value" in descriptor)) throw new Error("Continuation phase data hooks forbidden");
        characters += key.length; visit(descriptor.value, depth + 1);
      }
      active.delete(item);
    }
    if (characters > 8_000_000) throw new Error("Continuation phase JSON bounds exceeded");
  };
  visit(value, 0);
  return continuationJson(value);
}
const same = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right : continuationJson(left) === continuationJson(right);
function requireMatch(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`Continuation phase blocked: ${reason}`);
}
export function continuationPhaseWriter(value: unknown): ContinuationWriter {
  return z.object({ generation: integer.min(1), runId: id }).strict().parse(JSON.parse(json(value)));
}
export function continuationPhaseSnapshot(input: unknown, caseId: string, writer: ContinuationWriter): ContinuationPhaseSnapshot {
  const captured = json(input), snapshot = snapshotSchema.parse(JSON.parse(captured));
  requireMatch(continuationJson(snapshot) === captured, "schema changed JSON data");
  requireMatch(snapshot.caseId === caseId && snapshot.generation === writer.generation && snapshot.runId === writer.runId, "writer/identity mismatch");
  const body = snapshot.body;
  requireMatch(snapshot.sessionKey === `${body.phase}:${body.seat}:${body.channel}`, "session namespace mismatch");
  requireMatch(body.messages[0].role === "user" && JSON.stringify(body.messages).length <= 2_000_000, "context contract mismatch");
  JSON.parse(body.tools);
  const typed = snapshot.pipeline >= 3 && body.channel === "decision" && ["instruction", "criticism"].includes(body.phase);
  const turns = Object.entries(body.turns);
  requireMatch(turns.filter(([, t]) => !t.complete).length <= 1, "multiple incomplete turns");
  if (body.activeTurn) requireMatch(same(body.turns[body.activeTurn.id], body.activeTurn) && !body.activeTurn.complete, "active turn mismatch");
  for (const [key, t] of turns) {
    requireMatch(t.id === key && t.start <= body.messages.length && body.messages[t.start - 1].role === "user", "turn identity/offset mismatch");
    requireMatch(Date.parse(t.expiresAt) - Date.parse(t.startedAt) === (typed ? 600_000 : 300_000) && t.steps <= (body.channel === "preparation" ? 8 : 20), "turn budget mismatch");
    requireMatch(!t.inFlightStep || (body.channel === "decision" && t.inFlightStep === `decision:${body.id}:${t.id}:${t.steps}`), "in-flight step mismatch");
    requireMatch(!t.complete || !(t.inFlightStep || t.preparationCommand || t.preparationToolChoice || t.answer), "completion with unresolved effect");
    requireMatch(body.channel === "preparation" || (t.preparationCommand === undefined && t.preparationToolChoice === undefined && t.preparationBound === undefined && t.timedOut === undefined && t.draft === undefined), "channel mismatch");
    requireMatch(typed || (t.answer === undefined && t.reasoned === undefined), "typed contract mismatch");
    if (t.answer) requireMatch(t.answer.step < t.steps && t.reasoned === true && (Object.hasOwn(t.answer, "output") !== Object.hasOwn(t.answer, "error")), "typed answer mismatch");
    if (t.preparationCommand) requireMatch(Boolean(body.sandboxId) && t.preparationBound === true && t.preparationToolChoice !== undefined && t.preparationCommand.resultPath === `/workspace/result-${`${t.id}:${t.steps}`.replaceAll(":", "-")}.json`, "preparation command mismatch");
    for (const result of Object.values(t.results)) { requireMatch(Object.hasOwn(result, "output"), "result missing output"); JSON.parse(result.input); }
  }
  return snapshot;
}

// Same pure privacy projection as modelFacingEvents, kept local to avoid a
// store -> court-tools -> sources -> store runtime dependency cycle.
export function validateContinuationPhaseRecord(snapshot: ContinuationPhaseSnapshot, record: readonly RecordedEvent[]): void {
  const { body } = snapshot;
  requireMatch(record.length === body.cursor && record.every((e, index) => e.seq === index + 1) && continuationHash(record) === snapshot.recordHash, "committed prefix mismatch");
  const closes = record.filter(e => e.type === "instruction_closed");
  requireMatch(closes.length <= 1, "ambiguous instruction boundary");
  let cursor = 0;
  const turns = Object.values(body.turns).sort((a, b) => a.start - b.start);
  for (const [index, t] of turns.entries()) {
    requireMatch(index === 0 || t.start > turns[index - 1].start, "duplicate turn offset");
    const message = body.messages[t.start - 1];
    requireMatch(typeof message.content === "string", "begin message must be JSON text");
    const content = JSON.parse(message.content);
    json(content);
    const parsed = z.object({ events: z.array(z.object({ seq: integer.min(1) }).passthrough()), task: z.string() }).strict().parse(content);
    requireMatch(same(parsed, content) && JSON.stringify(content) === message.content, "begin JSON changed data");
    const cutoff = body.phase === "debate" ? closes[0]?.seq : 0;
    requireMatch(cutoff !== undefined, "debate before instruction closure");
    const high = parsed.events.at(-1)?.seq ?? Math.max(cursor, cutoff);
    const expected = record.filter(e => e.seq > Math.max(cursor, cutoff) && e.seq <= high);
    const projected = JSON.parse(JSON.stringify(expected, (key, value) => key === "translation" || key === "original" ? undefined : value));
    requireMatch(high >= cursor && high <= record.length && same(parsed.events, projected), "begin cursor delta mismatch");
    cursor = high;
  }
  requireMatch(cursor === body.cursor, "cursor not backed by begin ledger");
}

export function validateContinuationPhaseTransition(previous: ContinuationPhaseSnapshot, next: ContinuationPhaseSnapshot): void {
  const immutable = (s: ContinuationPhaseSnapshot) => { const { messages, cursor, turns, activeTurn, ...configuration } = s.body; void messages; void cursor; void turns; void activeTurn; return { ...s, body: configuration, recordHash: null }; };
  requireMatch(same(immutable(previous), immutable(next)), "immutable configuration/binding changed");
  const a = previous.body, b = next.body;
  requireMatch(b.cursor >= a.cursor && b.messages.length >= a.messages.length && a.messages.every((m, i) => same(m, b.messages[i])), "context/cursor reset");
  const added = Object.keys(b.turns).filter(key => !Object.hasOwn(a.turns, key));
  requireMatch(!added.length || Object.values(a.turns).every(t => t.complete), "new turn while prior outcome unresolved");
  requireMatch(added.every(key => b.turns[key].start > a.messages.length), "new turn reuses an existing message/budget frame");
  for (const [key, old] of Object.entries(a.turns)) {
    const fresh = b.turns[key];
    requireMatch(Boolean(fresh), "turn removed");
    if (old.complete) { requireMatch(same(old, fresh), "completed turn changed"); continue; }
    requireMatch(["id", "startedAt", "expiresAt", "start"].every(k => same(old[k as keyof typeof old], fresh[k as keyof typeof fresh])) && fresh.steps >= old.steps && (!old.done || fresh.done), "turn budget/identity reset");
    requireMatch(fresh.events.length >= old.events.length && old.events.every((e, i) => same(e, fresh.events[i])) && Object.entries(old.results).every(([k, value]) => same(value, fresh.results[k])), "turn result history changed");
    for (const marker of ["inFlightStep", "preparationCommand", "preparationToolChoice", "answer"] as const) if (old[marker] !== undefined) requireMatch(same(old[marker], fresh[marker]), "unproved effect marker cleared/changed");
    if (a.activeTurn?.id === key && !fresh.complete) requireMatch(b.activeTurn?.id === key, "active incomplete turn abandoned");
  }
}
