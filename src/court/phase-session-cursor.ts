import { types } from "node:util";
import { z } from "zod";
import type { CourtEvent } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { sha256 } from "../evidence/validate.ts";
import { modelFacingEvents, turnPhase } from "../instruction/court-tools.ts";
import { seatOf } from "./turns.ts";
import { verifyPhaseSessionExport, type PhaseSessionExport } from "./phase-session-export.ts";

// This checks begin()'s cursor, not completion of a procedure/round. Never a
// ready checkpoint, restorable conversation, or permission to execute a turn.
export const PHASE_SESSION_CURSOR_UNIT = "phase-session.cursor-offline-inspection";
const id = z.string().min(1).refine(value => value === value.trim());
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counsel = z.enum(["grok", "gemini", "claude", "chatgpt"]);
const specSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intake") }).strict(),
  z.object({ kind: z.literal("instruction"), counsel }).strict(),
  z.object({ kind: z.literal("unification") }).strict(),
  z.object({ kind: z.literal("source_review"), counsel }).strict(),
  z.object({ kind: z.literal("statement"), counsel, stage: z.enum(["opening", "rebuttal"]) }).strict(),
  z.object({ kind: z.literal("objection"), counsel, speaker: counsel, statementId: id }).strict(),
  z.object({ kind: z.literal("reply"), speaker: counsel, objector: counsel, objectionId: id }).strict(),
  z.object({ kind: z.literal("ruling"), objectionId: id }).strict(),
  z.object({ kind: z.literal("closing"), counsel }).strict(),
  z.object({ kind: z.literal("tiebreak") }).strict(),
  z.object({ kind: z.literal("content_vote"), counsel }).strict(),
  z.object({ kind: z.literal("content_tiebreak") }).strict(),
  z.object({ kind: z.literal("summary") }).strict(),
]);
// Event PAYLOADS are opaque here. Only Expert discriminators/stamps and the
// closing boundary needed by begin() are checked; no artifact is authenticated.
const event = z.object({ type: z.enum([
  "session_opened", "claims_entered", "dismissed", "instruction_opened", "evidence_filed", "evidence_proposed",
  "instruction_completed", "source_collection_started", "source_batch_started", "source_batch_completed",
  "evidence_unified", "source_review_vote", "source_decided", "evidence_settled", "instruction_closed",
  "floor_granted", "statement", "objection", "objection_reply", "ruling", "vote", "judgment", "content_vote",
  "content_judgment", "case_summary", "absence", "session_closed",
]), seq: integer.min(1), at: z.iso.datetime() }).passthrough();
const opening = z.object({ type: z.literal("session_opened"), seq: z.literal(1), at: z.iso.datetime(), judgeModel: id,
  counselModels: z.object({ grok: id, gemini: id, claude: id, chatgpt: id }).strict(),
  judgeEffort: z.string().nullable().optional(), counselEfforts: z.object({ grok: z.string().nullable(), gemini: z.string().nullable(), claude: z.string().nullable(), chatgpt: z.string().nullable() }).strict().optional(),
  simulated: z.boolean().optional(),
}).strict();
export const PhaseSessionCursorExpectationSchema = z.object({
  mode: z.literal("expert"), session: z.unknown(), recordHash: hash, evidenceHash: hash,
  // Pins supplied independently. specJson retains the legacy ID's JSON order;
  // taskHash pins exact prose/preparation, which is never reconstructed here.
  turns: z.array(z.object({ id, specJson: z.string().min(1), attempt: z.union([z.literal(0), z.literal(1)]), recordLength: integer, taskHash: hash }).strict()).max(1000),
}).strict();
export const PhaseSessionCursorExportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("phase_session_cursor_offline_export"),
  session: z.unknown(), record: z.array(event).min(1).max(10_000),
}).strict();
export type PhaseSessionCursorExpectation = z.infer<typeof PhaseSessionCursorExpectationSchema>;
export type PhaseSessionCursorExport = z.infer<typeof PhaseSessionCursorExportSchema>;

// Resource limits before canonicalization/schema traversal, as in the existing
// offline exports. Reject data hooks rather than invoking or normalizing them.
function boundedJson(value: unknown): void {
  let nodes = 0, characters = 0;
  const active = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error("Phase cursor exceeds offline JSON bounds");
    if (typeof current === "string") characters += current.length;
    else if (typeof current === "number") { if (!Number.isFinite(current)) throw new Error("Phase cursor requires finite JSON"); }
    else if (current !== null && typeof current !== "boolean") {
      if (!current || typeof current !== "object" || types.isProxy(current) || active.has(current)) throw new Error("Phase cursor requires acyclic plain JSON");
      const array = Array.isArray(current);
      if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype)) throw new Error("Phase cursor requires plain JSON");
      const descriptors = Object.getOwnPropertyDescriptors(current), keys = Reflect.ownKeys(current);
      const length = array ? descriptors.length.value as number : 0;
      if (array && (length > 100_000 || keys.length !== length + 1)) throw new Error("Phase cursor requires dense JSON arrays");
      active.add(current);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") throw new Error("Phase cursor requires JSON keys");
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new Error("Phase cursor requires ordinary JSON data");
        characters += key.length; visit(descriptor.value, depth + 1);
      }
      active.delete(current);
    }
    if (characters > 8_000_000) throw new Error("Phase cursor exceeds offline JSON bounds");
  };
  visit(value, 0);
}
function requireMatch(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`Phase cursor blocked: ${reason}`);
}
const equal = (left: unknown, right: unknown) => continuationJson(left) === continuationJson(right);

export function verifyPhaseSessionCursor(expectationInput: unknown, exportInput: unknown) {
  boundedJson(expectationInput); boundedJson(exportInput);
  const expected = PhaseSessionCursorExpectationSchema.parse(expectationInput), exported = PhaseSessionCursorExportSchema.parse(exportInput);
  requireMatch(equal(expected, expectationInput) && equal(exported, exportInput), "schema parsing changed JSON data");
  requireMatch(continuationHash(exportInput) === expected.evidenceHash && continuationHash(exported.record) === expected.recordHash, "independent record/evidence hash mismatch");
  const inspected = verifyPhaseSessionExport(expected.session, exported.session);
  const { body } = exported.session as PhaseSessionExport; // Existing verifier checked the complete envelope without data loss.
  const record = exported.record;
  const opened = opening.parse(record[0]);
  requireMatch(record.every((e, index) => e.seq === index + 1 && (index === 0 || e.type !== "session_opened")), "record sequence gap/duplicate opening");
  requireMatch(body.model.id === (body.seat === "judge" ? opened.judgeModel : opened.counselModels[body.seat]), "opening/session model mismatch");
  const closed = record.filter(e => e.type === "instruction_closed");
  requireMatch(closed.length <= 1 && closed.every(e => equal(e, { type: "instruction_closed", seq: e.seq, at: e.at })), "ambiguous instruction boundary");
  const saved = Object.values(body.turns).sort((left, right) => left.start - right.start);
  requireMatch(saved.length === expected.turns.length && saved.every((turn, index) => index === 0 || turn.start > saved[index - 1].start), "complete unique turn ledger required");
  let cursor = 0;
  const turns = saved.map((turn, index) => {
    const pin = expected.turns[index];
    requireMatch(pin.id === turn.id && pin.recordLength >= cursor && pin.recordLength <= record.length, "turn order or non-prefix record mismatch");
    const rawSpec = JSON.parse(pin.specJson);
    boundedJson(rawSpec);
    const spec = specSchema.parse(rawSpec);
    requireMatch(equal(spec, rawSpec) && JSON.stringify(rawSpec) === pin.specJson && turnPhase(spec) === body.phase && seatOf(spec) === body.seat, "turn spec/phase/seat mismatch");
    const prefix = record.slice(0, pin.recordLength);
    // Exactly settled-play's ID, NOT the canonical JSON hash or an alias.
    requireMatch(turn.id === sha256(JSON.stringify([rawSpec, pin.attempt, ...prefix.map(e => e.seq)])), "legacy turn ID/input mismatch");
    const boundary = body.phase === "debate" ? closed.find(e => e.seq <= pin.recordLength)?.seq : 0;
    requireMatch(boundary !== undefined, "debate began before instruction closed");
    const unseen = prefix.filter(e => e.seq > Math.max(cursor, boundary));
    const message = body.messages[turn.start - 1];
    requireMatch(typeof message.content === "string", "begin message must be JSON text");
    const content = JSON.parse(message.content);
    boundedJson(content);
    requireMatch(JSON.stringify(content) === message.content, "begin message is not lossless JSON serialization");
    requireMatch(equal(content, { events: modelFacingEvents(unseen as CourtEvent[]), task: content.task }) && typeof content.task === "string" && continuationHash(content.task) === pin.taskHash, "begin events/task mismatch");
    let task = content.task;
    if (body.channel === "decision") {
      const wrapper = JSON.parse(content.task);
      boundedJson(wrapper);
      requireMatch(JSON.stringify(wrapper) === content.task, "decision wrapper is not lossless JSON serialization");
      task = z.object({ task: z.string(), preparation: z.string() }).strict().parse(wrapper).task;
    }
    requireMatch(task.startsWith(pin.specJson + "\n"), "task/spec mismatch");
    const previous = cursor;
    cursor = pin.recordLength; // Contiguous prefix: max(seq) in begin(), not number of visible events.
    return { id: turn.id, start: turn.start, previousCursor: previous, recordedCursor: cursor, instructionCutoff: boundary,
      visibleSeqs: unseen.map(e => e.seq), taskHash: pin.taskHash };
  });
  requireMatch(body.cursor === cursor, "saved cursor exceeds or trails observed begins");
  return { state: "verified-offline" as const, unit: PHASE_SESSION_CURSOR_UNIT, continuationEnabled: false as const,
    origin: inspected.origin, exportHash: inspected.exportHash, recordHash: expected.recordHash, evidenceHash: expected.evidenceHash,
    recordedCursor: cursor, nextRecordSeq: record.length + 1, turns, recordedTurns: inspected.turns,
    blockers: [...inspected.blockers, "phase_cursor_committed_record_origin_unproved", "phase_cursor_round_completion_unproved", "phase_cursor_preparation_provenance_unproved"] };
}

export function phaseSessionCursorPreflight(expectation: unknown, exported: unknown) {
  const blockers = ["historical_inactivity_unproved", "generation_fencing_and_effects_unproved", "continuation_disabled"];
  try {
    return { state: "blocked" as const, continuationEnabled: false as const, blockers, cursorInspection: verifyPhaseSessionCursor(expectation, exported) };
  } catch {
    return { state: "blocked" as const, continuationEnabled: false as const, blockers: ["phase_cursor_evidence_invalid", ...blockers] };
  }
}
