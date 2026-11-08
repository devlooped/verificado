import { types } from "node:util";
import { z } from "zod";
import { continuationHash, continuationJson } from "../domain/continuation.ts";

// Offline envelope only. Legacy PhaseState has no generation/origin/version;
// none is inferred, promoted, or written back by this module.
export const PHASE_SESSION_EXPORT_UNIT = "phase-session.offline-inspection";
const id = z.string().min(1).refine(value => value === value.trim());
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.iso.datetime();
const phase = z.enum(["intake", "instruction", "criticism", "debate"]);
const seat = z.enum(["judge", "grok", "gemini", "claude", "chatgpt"]);
const channel = z.enum(["preparation", "decision"]);
const model = z.object({ id, providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict();
const message = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.union([z.string(), z.array(z.unknown())]),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict();
const turn = z.object({
  id, startedAt: at, expiresAt: at, start: integer.min(1), steps: integer,
  inFlightStep: id.optional(), preparationToolChoice: z.enum(["auto", "none"]).optional(),
  preparationCommand: z.object({ id, resultPath: id }).strict().optional(),
  preparationBound: z.boolean().optional(), timedOut: z.boolean().optional(), reasoned: z.boolean().optional(),
  answer: z.object({ step: integer, output: z.unknown().optional(), error: z.string().min(1).optional() }).strict().optional(),
  events: z.array(z.unknown()), done: z.boolean(), complete: z.boolean(), draft: z.string().optional(),
  results: z.record(z.string(), z.object({ input: z.string().min(1), output: z.unknown() }).strict()),
}).strict();
const state = z.object({
  id, createdAt: at, phase, seat, channel, model, system: z.string(), tools: z.string(),
  messages: z.array(message).min(1), cursor: integer, turns: z.record(z.string(), turn),
  activeTurn: turn.optional(), sandboxId: id.optional(),
}).strict();
export const PhaseSessionOriginSchema = z.object({
  caseId: id, pipeline: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  generation: integer, runId: id, deploymentId: id, sessionId: id, sessionKey: id, storageKey: id,
}).strict();
export const PhaseSessionExportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("phase_session_offline_export"),
  origin: PhaseSessionOriginSchema, revision: integer, body: state,
}).strict();
export const PhaseSessionExpectationSchema = z.object({
  origin: PhaseSessionOriginSchema, revision: integer, exportHash: hash,
  configuration: z.object({ phase, seat, channel, model, system: z.string(), tools: z.string(), initialMessageHash: hash }).strict(),
  // An explicit inspection instant, NOT a runtime clock or a new deadline.
  observedAt: at,
}).strict();
export type PhaseSessionExport = z.infer<typeof PhaseSessionExportSchema>;
export type PhaseSessionExpectation = z.infer<typeof PhaseSessionExpectationSchema>;

// Separate offline resource bounds. Match the existing canonicalizer's JSON
// rules before schema traversal, without invoking getters/proxy traps/toJSON.
function boundedJson(value: unknown): void {
  let nodes = 0, characters = 0;
  const active = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error("Phase export exceeds offline JSON bounds");
    if (typeof current === "string") characters += current.length;
    else if (typeof current === "number") { if (!Number.isFinite(current)) throw new Error("Phase export requires finite JSON"); }
    else if (current !== null && typeof current !== "boolean") {
      if (!current || typeof current !== "object" || types.isProxy(current) || active.has(current)) throw new Error("Phase export requires acyclic plain JSON");
      const array = Array.isArray(current);
      if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype)) throw new Error("Phase export requires plain JSON");
      const descriptors = Object.getOwnPropertyDescriptors(current), keys = Reflect.ownKeys(current);
      const length = array ? descriptors.length.value as number : 0;
      if (array && (length > 100_000 || keys.length !== length + 1)) throw new Error("Phase export requires dense JSON arrays");
      active.add(current);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") throw new Error("Phase export requires JSON keys");
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new Error("Phase export requires ordinary JSON data");
        characters += key.length;
        visit(descriptor.value, depth + 1);
      }
      active.delete(current);
    }
    if (characters > 8_000_000) throw new Error("Phase export exceeds offline JSON bounds");
  };
  visit(value, 0);
}

function requireMatch(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`Phase export blocked: ${reason}`);
}
const equal = (left: unknown, right: unknown) => continuationJson(left) === continuationJson(right);

// No PhaseSession, repository, artifact reader, clock, provider or workflow is
// called. Returns a diagnostic only: NEVER a restorable state/result/checkpoint.
export function verifyPhaseSessionExport(expectationInput: unknown, exportInput: unknown) {
  boundedJson(expectationInput); boundedJson(exportInput);
  const expected = PhaseSessionExpectationSchema.parse(expectationInput);
  const exported = PhaseSessionExportSchema.parse(exportInput);
  requireMatch(equal(expected, expectationInput) && equal(exported, exportInput), "schema parsing changed JSON data");
  const { body, origin } = exported;
  requireMatch(equal(origin, expected.origin) && exported.revision === expected.revision, "origin/generation/revision mismatch");
  requireMatch(continuationHash(exportInput) === expected.exportHash, "export hash mismatch");
  const { initialMessageHash, ...configuration } = expected.configuration;
  const actual = { phase: body.phase, seat: body.seat, channel: body.channel, model: body.model, system: body.system, tools: body.tools };
  requireMatch(equal(actual, configuration) && continuationHash(body.messages[0]) === initialMessageHash, "phase configuration/prefix mismatch");
  const key = `${body.phase}:${body.seat}:${body.channel}`;
  requireMatch(body.id === origin.sessionId && origin.sessionKey === key && origin.storageKey === (origin.generation ? `generation:${origin.generation}:${key}` : key), "session identity/namespace mismatch");
  // This is the real save() limit: UTF-16 JSON string length, NOT bytes/tokens.
  requireMatch(JSON.stringify(body.messages).length <= 2_000_000, "phase context limit");
  requireMatch(body.messages[0].role === "user", "initial user message required");
  JSON.parse(body.tools); // Persisted tools are JSON text; never normalize it.
  if (body.activeTurn) {
    requireMatch(Object.hasOwn(body.turns, body.activeTurn.id) && equal(body.turns[body.activeTurn.id], body.activeTurn) && !body.activeTurn.complete, "active turn mismatch");
  }
  const typed = origin.pipeline >= 3 && (body.phase === "instruction" || body.phase === "criticism") && body.channel === "decision";
  const stepLimit = body.channel === "preparation" ? 8 : 20;
  const duration = typed ? 600_000 : 300_000;
  const turns = Object.entries(body.turns).map(([turnId, saved]) => {
    requireMatch(saved.id === turnId && saved.start <= body.messages.length && body.messages[saved.start - 1].role === "user", "turn identity/message offset mismatch");
    requireMatch(Date.parse(saved.expiresAt) - Date.parse(saved.startedAt) === duration && saved.steps <= stepLimit, "turn budget contract mismatch");
    requireMatch(!saved.inFlightStep || (body.channel === "decision" && saved.inFlightStep === `decision:${body.id}:${saved.id}:${saved.steps}`), "in-flight step mismatch");
    requireMatch(body.channel === "preparation" || (saved.preparationToolChoice === undefined && saved.preparationCommand === undefined && saved.preparationBound === undefined && saved.timedOut === undefined && saved.draft === undefined), "preparation/decision mismatch");
    requireMatch(typed || (saved.answer === undefined && saved.reasoned === undefined), "typed answer contract mismatch");
    if (saved.answer) requireMatch(saved.answer.step < saved.steps && saved.reasoned === true && (Object.hasOwn(saved.answer, "output") !== Object.hasOwn(saved.answer, "error")), "typed answer step/result mismatch");
    if (saved.preparationCommand) requireMatch(Boolean(body.sandboxId) && saved.preparationBound === true && saved.preparationToolChoice !== undefined && saved.preparationCommand.resultPath === `/workspace/result-${`${saved.id}:${saved.steps}`.replaceAll(":", "-")}.json`, "preparation command/binding mismatch");
    for (const result of Object.values(saved.results)) JSON.parse(result.input);
    const unresolved = [saved.inFlightStep ? "model_step_in_flight" : "", saved.preparationCommand ? "preparation_command_in_flight" : "",
      saved.preparationToolChoice && !saved.preparationCommand ? "preparation_call_outcome_unproved" : "", saved.answer ? "typed_answer_not_applied" : ""].filter(Boolean);
    const deadlineElapsed = Date.parse(expected.observedAt) >= Date.parse(saved.expiresAt);
    // complete can be true with done=false, or after a native empty timeout.
    // Even consistent local markers do NOT prove results or completion time.
    const hasLocalResult = body.channel === "preparation" ? Boolean(saved.draft?.trim()) : Object.keys(saved.results).length > 0 && saved.events.length > 0;
    const status = unresolved.length ? "unresolved" : saved.timedOut || (!saved.complete && (saved.steps >= stepLimit || deadlineElapsed)) ? "exhausted"
      : saved.complete && saved.done && hasLocalResult ? "locally-finalized" : saved.complete ? "result-unproved" : "interrupted";
    return { id: saved.id, status, recordedSteps: saved.steps, stepLimit, startedAt: saved.startedAt, expiresAt: saved.expiresAt,
      deadlineElapsed, start: saved.start, completeMarker: saved.complete, doneMarker: saved.done, unresolved };
  });
  return { state: "verified-offline" as const, unit: PHASE_SESSION_EXPORT_UNIT, continuationEnabled: false as const,
    origin, revision: exported.revision, exportHash: expected.exportHash, cursor: body.cursor, turns,
    blockers: phaseSessionExportPreflight().blockers };
}

export function phaseSessionExportPreflight() {
  return { state: "blocked" as const, continuationEnabled: false as const, blockers: [
    "phase_session_origin_unproved", "phase_session_event_prefix_unproved", "phase_session_message_semantics_unproved",
    "phase_session_operation_coverage_unproved", "phase_session_completion_time_unproved", "phase_session_runtime_recovery_unproved",
  ] };
}
