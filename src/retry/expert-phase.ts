import { types } from "node:util";
import { z } from "zod";
import type { PhaseRepository, PhaseState } from "../court/phase-session.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryRepository, RetryUnit, RetryUnitSpec } from "../domain/retry-state.ts";

// This is an isolated NEW-workflow checkpoint adapter, not an Expert runtime.
// A claimed but incomplete checkpoint blocks: there is no lease-based takeover.
const MAX_REVISIONS = 1024;
const MAX_NODES = 100_000;
const MAX_CHARS = 8_000_000;
const id = z.string().min(1).max(256);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const model = z.strictObject({ id, providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional() });
const message = z.strictObject({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.union([z.string(), z.array(z.json())]),
  providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional() });
const turn = z.strictObject({
  id, startedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), start: integer.min(1), steps: integer,
  inFlightStep: id.optional(), preparationToolChoice: z.enum(["auto", "none"]).optional(),
  preparationCommand: z.strictObject({ id, resultPath: id }).optional(), preparationBound: z.boolean().optional(),
  timedOut: z.boolean().optional(), reasoned: z.boolean().optional(),
  answer: z.strictObject({ step: integer, output: z.json().optional(), error: z.string().optional() }).optional(),
  events: z.array(z.json()), done: z.boolean(), complete: z.boolean(), draft: z.string().optional(),
  results: z.record(z.string(), z.strictObject({ input: z.string().min(1), output: z.json() })),
});
const state = z.strictObject({
  id, createdAt: z.iso.datetime(), phase: z.enum(["intake", "instruction", "criticism", "debate"]),
  seat: z.enum(["judge", "grok", "gemini", "claude", "chatgpt"]), channel: z.enum(["preparation", "decision"]),
  model, system: z.string(), tools: z.string(), messages: z.array(message).min(1), cursor: integer,
  turns: z.record(z.string(), turn), activeTurn: turn.optional(), sandboxId: id.optional(),
});
const envelope = z.strictObject({ format: z.literal(1), caseId: id, runId: id, key: id, revision: integer, body: state });
type Checkpoint = z.infer<typeof envelope>;
const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const blocked = (): never => { throw new Error("Expert phase checkpoint rejected"); };

// Refuse lossy JSON and cap work before canonicalization/schema parsing. Never
// invoke accessors, toJSON, or traverse non-plain values such as binary parts.
function bounded(value: unknown): void {
  let nodes = 0, chars = 0;
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 32) blocked();
    if (typeof v === "string") chars += v.length;
    else if (typeof v === "number") { if (!Number.isFinite(v)) blocked(); }
    else if (v !== null && typeof v !== "boolean") {
      if (!v || typeof v !== "object" || active.has(v)) return blocked();
      // continuationJson also rejects proxies, but do so before any reflection.
      if (isProxy(v)) return blocked();
      const array = Array.isArray(v);
      if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) blocked();
      const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
      const length = array ? descriptors.length.value as number : 0;
      if (array && (length > MAX_NODES || keys.length !== length + 1)) blocked();
      active.add(v);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") return blocked();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) blocked();
        chars += key.length; visit(descriptor.value, depth + 1);
      }
      active.delete(v);
    }
    if (chars > MAX_CHARS) blocked();
  };
  visit(value, 0);
}
const isProxy = types.isProxy;

function validateBody(value: unknown, key: string, initial: string): PhaseState {
  bounded(value);
  const parsed = state.safeParse(value);
  if (!parsed.success || !same(parsed.data, value)) return blocked();
  const body = parsed.data;
  if (`${body.phase}:${body.seat}:${body.channel}` !== key || JSON.stringify(body.messages).length > 2_000_000) blocked();
  const first = { role: "user", content: initial, ...(body.model.id.startsWith("anthropic/") ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}) };
  if (!same(body.messages[0], first)) blocked();
  for (const [turnId, t] of Object.entries(body.turns)) {
    if (turnId !== t.id || t.start > body.messages.length || body.messages[t.start - 1].role !== "user" || Date.parse(t.expiresAt) < Date.parse(t.startedAt)) blocked();
    for (const event of t.events) {
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" ||
          !event.type || typeof event.at !== "string" || !z.iso.datetime().safeParse(event.at).success) blocked();
    }
    for (const result of Object.values(t.results)) {
      if (!Object.hasOwn(result, "output")) blocked();
      try { JSON.parse(result.input); } catch { blocked(); }
    }
  }
  if (body.activeTurn && (!Object.hasOwn(body.turns, body.activeTurn.id) || body.activeTurn.complete || !same(body.activeTurn, body.turns[body.activeTurn.id]))) blocked();
  return body as PhaseState;
}

function follows(previous: PhaseState, next: PhaseState): void {
  if (!same([previous.id, previous.createdAt, previous.phase, previous.seat, previous.channel, previous.model, previous.system, previous.tools],
    [next.id, next.createdAt, next.phase, next.seat, next.channel, next.model, next.system, next.tools]) || next.cursor < previous.cursor ||
    (previous.sandboxId !== undefined && previous.sandboxId !== next.sandboxId) ||
    next.messages.length < previous.messages.length || !same(previous.messages, next.messages.slice(0, previous.messages.length))) blocked();
  for (const [key, old] of Object.entries(previous.turns)) {
    const current = next.turns[key];
    if (!current || old.id !== current.id || old.startedAt !== current.startedAt || old.expiresAt !== current.expiresAt ||
      old.start !== current.start || current.steps < old.steps || (old.complete && !same(old, current)) ||
      current.events.length < old.events.length || !same(old.events, current.events.slice(0, old.events.length))) blocked();
    for (const [resultId, result] of Object.entries(old.results)) {
      if (!Object.hasOwn(current.results, resultId) || !same(result, current.results[resultId])) blocked();
    }
  }
}

function unitKey(key: string, revision: number): string { return `expert/phase/${continuationHash(key)}/${revision}`; }
function spec(fence: RetryFence, key: string, revision: number, previousHash: string | null, body: PhaseState): RetryUnitSpec {
  return { key: unitKey(key, revision), kind: "expert.phase.checkpoint", format: 1,
    dependencies: revision ? [unitKey(key, revision - 1)] : [], effect: "pure", estimatedCost: null,
    input: { caseId: fence.caseId, runId: fence.runId, key, revision, previousHash, bodyHash: continuationHash(body) } };
}
function verifyUnit(unit: RetryUnit, expected: RetryUnitSpec): void {
  bounded(unit);
  const actual = { key: unit.key, kind: unit.kind, format: unit.format, dependencies: unit.dependencies, effect: unit.effect, estimatedCost: unit.estimatedCost, input: unit.input };
  if (!same(actual, expected) || unit.inputHash !== continuationHash(expected.input) || unit.state !== "ready" ||
      unit.result === undefined || unit.resultHash !== continuationHash(unit.result) || !unit.owner ||
      !Number.isSafeInteger(unit.attempt) || unit.attempt < 0 || !Number.isSafeInteger(unit.epoch) || unit.epoch < 0) blocked();
}

// The caller must pass the same trusted initial prompt used in PhaseSession.open.
// The PhaseRepository interface does not pass open's input to load(), so this pin
// cannot itself detect a caller opening with a different prompt.
export class RetryExpertPhaseRepository implements PhaseRepository {
  private readonly fence: RetryFence;
  constructor(private readonly retry: RetryRepository, fence: RetryFence, private readonly initial: string) {
    bounded(fence);
    this.fence = JSON.parse(continuationJson(fence)) as RetryFence;
    if (typeof initial !== "string" || initial.length > MAX_CHARS) blocked();
  }

  private async checkpoints(caseId: string, key: string): Promise<{ latest?: Checkpoint; hash: string | null }> {
    if (caseId !== this.fence.caseId || typeof key !== "string" || !key || key.length > 256) return blocked();
    const record: RetryRecord | null = await this.retry.read(caseId);
    const contract = record?.contract && parseRetryContract(record.contract);
    if (!record || !contract || record.state !== "active" || !same(record.fence, this.fence) ||
      contract.configuration.check !== "expert" || contract.creation.caseId !== caseId || contract.binding.runId !== this.fence.runId) return blocked();
    const prefix = `expert/phase/${continuationHash(key)}/`;
    const relevant = record.units.filter(unit => unit.key.startsWith(prefix));
    if (relevant.length > MAX_REVISIONS) blocked();
    const units = new Map<string, RetryUnit>();
    for (const unit of relevant) {
      if (units.has(unit.key)) blocked();
      units.set(unit.key, unit);
    }
    let latest: Checkpoint | undefined, hash: string | null = null;
    for (let revision = 0; revision < relevant.length; revision++) {
      const unit = units.get(unitKey(key, revision));
      if (!unit) return blocked();
      bounded(unit.result);
      const parsed = envelope.safeParse(unit.result);
      if (!parsed.success || !same(parsed.data, unit.result)) return blocked();
      const value = parsed.data;
      if (value.caseId !== caseId || value.runId !== this.fence.runId || value.key !== key || value.revision !== revision) blocked();
      const body = validateBody(value.body, key, this.initial);
      if (latest) follows(latest.body as PhaseState, body);
      verifyUnit(unit, spec(this.fence, key, revision, hash, body));
      if (unit.attempt > this.fence.attempt || unit.epoch > this.fence.epoch) blocked();
      latest = value; hash = unit.resultHash!;
    }
    return { latest, hash };
  }

  async load(caseId: string, key: string): Promise<{ revision: number; body: PhaseState } | undefined> {
    const { latest } = await this.checkpoints(caseId, key);
    if (!latest) return undefined;
    const body = latest.body as PhaseState;
    // JSON has value equality, not identity. PhaseSession mutates activeTurn in
    // place and expects turns[id] to be that exact object after reopening.
    if (body.activeTurn) body.activeTurn = body.turns[body.activeTurn.id];
    return { revision: latest.revision, body };
  }

  async save(caseId: string, key: string, revision: number, body: PhaseState): Promise<number> {
    if (!Number.isSafeInteger(revision) || revision < -1 || revision + 1 >= MAX_REVISIONS) return blocked();
    const snapshot = validateBody(body, key, this.initial);
    const { latest, hash } = await this.checkpoints(caseId, key);
    if ((latest?.revision ?? -1) !== revision) return blocked();
    if (latest) follows(latest.body as PhaseState, snapshot);
    const next = revision + 1, unit = spec(this.fence, key, next, hash, snapshot);
    const claim = await this.retry.claimUnit(this.fence, unit);
    // Even identical concurrent writes must not both satisfy the revision CAS.
    if (claim.state !== "claimed") return blocked();
    await this.retry.completeUnit(this.fence, unit.key, claim.owner,
      { format: 1, caseId, runId: this.fence.runId, key, revision: next, body: snapshot });
    return next;
  }
}
