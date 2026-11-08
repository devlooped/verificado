// Offline evidence ONLY. Real begin/finish use memory CAS; no runtime recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { COUNSEL, type RecordedEvent } from "../domain/court.ts";
import { CONTINUATION_ENABLED, continuationHash, requireContinuationEnabled, type ContinuationCheckpoint } from "../domain/continuation.ts";
import { sha256 } from "../evidence/validate.ts";
import { publishContinuationCheckpoint } from "../store.ts";
import { holdSession } from "./procedure.ts";
import { PhaseSession, MemoryPhaseRepository } from "./phase-session.ts";
import type { PhaseSessionExport, PhaseSessionExpectation } from "./phase-session-export.ts";
import { verifyPhaseSessionCursor, phaseSessionCursorPreflight, PhaseSessionCursorExportSchema, type PhaseSessionCursorExport, type PhaseSessionCursorExpectation } from "./phase-session-cursor.ts";

const at = "2026-11-07T12:00:00.000Z";
const models = { judge: "fixture/model", counsel: Object.fromEntries(COUNSEL.map(by => [by, "fixture/model"])) as Record<(typeof COUNSEL)[number], string> };
function record(): RecordedEvent[] {
  return [{ type: "session_opened", ...{ judgeModel: models.judge, counselModels: models.counsel }, seq: 1, at },
    { type: "claims_entered", claims: [{ id: "A1", quote: "quote", text: "An exact fixture claim." }], seq: 2, at },
    { type: "instruction_opened", seq: 3, at }, { type: "instruction_completed", by: "gemini", searches: [], seq: 4, at },
    { type: "instruction_closed", seq: 5, at }, { type: "floor_granted", to: "grok", stage: "opening", seq: 6, at },
    { type: "statement", id: "S1", by: "grok", stage: "opening", text: "Canonical statement.", evidenceIds: [], seq: 7, at },
    { type: "floor_granted", to: "grok", stage: "closing", seq: 8, at }];
}
function sessionExpectation(session: PhaseSessionExport): PhaseSessionExpectation {
  const { body } = session;
  return { origin: structuredClone(session.origin), revision: session.revision, exportHash: continuationHash(session),
    configuration: { phase: body.phase, seat: body.seat, channel: body.channel, model: structuredClone(body.model), system: body.system, tools: body.tools, initialMessageHash: continuationHash(body.messages[0]) },
    observedAt: Object.values(body.turns)[0]?.startedAt ?? body.createdAt };
}
function repin(exported: PhaseSessionCursorExport, expected: PhaseSessionCursorExpectation) {
  return { ...expected, session: sessionExpectation(exported.session as PhaseSessionExport), recordHash: continuationHash(exported.record), evidenceHash: continuationHash(exported) };
}
async function fixture(phase: "intake" | "instruction" | "criticism" | "debate" = "debate", channel: "preparation" | "decision" = "decision", pipeline: 2 | 3 | 4 | 5 = 2, supplied = record()) {
  const repository = new MemoryPhaseRepository(), seat = phase === "intake" ? "judge" : "grok";
  const session = await PhaseSession.open("fixture", { phase, seat, channel, model: { id: "fixture/model" }, system: "Pinned system.", tools: "{}", initial: "Pinned initial message." }, repository);
  const entries = phase === "debate" ? [{ spec: { kind: "statement", counsel: "grok", stage: "opening" }, length: 6 }, { spec: { kind: "closing", counsel: "grok" }, length: 8 }]
    : phase === "intake" ? [{ spec: { kind: "intake" }, length: 1 }]
    : [{ spec: { kind: phase === "instruction" ? "instruction" : "source_review", counsel: "grok" }, length: 3 }, { spec: { kind: phase === "instruction" ? "instruction" : "source_review", counsel: "grok" }, length: 4 }];
  const pins: PhaseSessionCursorExpectation["turns"] = [];
  for (const [index, entry] of entries.entries()) {
    const specJson = JSON.stringify(entry.spec), attempt = index as 0 | 1;
    const prefix = supplied.slice(0, entry.length);
    const id = sha256(JSON.stringify([entry.spec, attempt, ...prefix.map(e => e.seq)]));
    const task = specJson + "\nPinned task and index.\n";
    const beginTask = channel === "decision" ? JSON.stringify({ task, preparation: "Pinned preparatory draft." }) : task;
    await session.begin(id, prefix, beginTask, channel === "decision" && pipeline >= 3 && (phase === "instruction" || phase === "criticism") ? 600_000 : undefined);
    pins.push({ id, specJson, attempt, recordLength: prefix.length, taskHash: continuationHash(beginTask) });
    if (index < entries.length - 1) { await session.append([{ role: "assistant", content: "Locally saved, not a proved result." }]); await session.finish(); }
  }
  const row = (await repository.load("fixture", session.key))!;
  const body: PhaseSessionExport = { schemaVersion: 1, kind: "phase_session_offline_export", origin: { caseId: "fixture", pipeline, generation: 0, runId: "fixture-run", deploymentId: "fixture-deployment", sessionId: session.state.id, sessionKey: session.key, storageKey: session.key }, revision: row.revision, body: row.body };
  const exported: PhaseSessionCursorExport = { schemaVersion: 1, kind: "phase_session_cursor_offline_export", session: body, record: PhaseSessionCursorExportSchema.shape.record.parse(supplied) };
  const expected = repin(exported, { mode: "expert", session: sessionExpectation(body), recordHash: continuationHash(supplied), evidenceHash: continuationHash(exported), turns: pins });
  return { exported, expected };
}

test("real memory begin cursor verifies a real Expert orchestration prefix without a restored turn", async () => {
  const events: RecordedEvent[] = [];
  await assert.rejects(holdSession({ submission: { kind: "text", text: "Fixture only." }, models,
    play: async spec => { assert.equal(spec.kind, "intake"); const entered = record()[1]; if (entered.type !== "claims_entered") throw new Error("Invalid fixture"); return { done: true, events: [{ type: "claims_entered", claims: entered.claims, at }] }; },
    commit: async batch => { events.push(...batch); if (batch.some(e => e.type === "instruction_opened")) throw new Error("fixture stop"); },
  }), /fixture stop/);
  const { exported, expected } = await fixture("intake", "decision", 2, events);
  const report = verifyPhaseSessionCursor(expected, exported);
  assert.deepEqual(report.turns[0].visibleSeqs, [1]); assert.equal(report.recordedCursor, 1); assert.equal(report.nextRecordSeq, 4);
  assert.equal(report.continuationEnabled, false); assert.equal(report.recordedTurns[0].status, "interrupted");
  for (const field of ["checkpoint", "body", "result", "ready", "remainingBudget", "nextTurn"]) assert.equal(Object.hasOwn(report, field), false);
});
test("Expert 2–5 preparation/decision cursors preserve delta, recorded steps and original deadlines", async () => {
  for (const pipeline of [2, 3, 4, 5] as const) for (const channel of ["preparation", "decision"] as const) for (const phase of ["instruction", "criticism", "debate"] as const) {
    const { exported, expected } = await fixture(phase, channel, pipeline);
    const before = JSON.stringify(exported), report = verifyPhaseSessionCursor(expected, exported);
    assert.deepEqual(report.turns.map(t => t.visibleSeqs), phase === "debate" ? [[6], [7, 8]] : [[1, 2, 3], [4]]);
    assert.equal(report.recordedCursor, phase === "debate" ? 8 : 4); assert.equal(report.nextRecordSeq, 9);
    assert.equal(report.recordedTurns[0].recordedSteps, 1); assert.equal(JSON.stringify(exported), before);
  }
});
test("verification uses no DB, fetch or clock; repetitions do not begin or renew anything", async t => {
  const { exported, expected } = await fixture(); let effects = 0;
  const forbidden = () => { effects++; throw new Error("Effect forbidden"); };
  t.mock.method(Pool.prototype, "query", forbidden as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", forbidden as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", forbidden); t.mock.method(Date, "now", forbidden);
  t.mock.method(PhaseSession, "open", forbidden); t.mock.method(PhaseSession.prototype, "begin", forbidden);
  const before = JSON.stringify(exported), report = verifyPhaseSessionCursor(expected, exported);
  for (let i = 0; i < 3; i++) assert.deepEqual(verifyPhaseSessionCursor(expected, exported), report);
  assert.equal(JSON.stringify(exported), before); assert.equal(effects, 0); assert.equal(CONTINUATION_ENABLED, false);
  assert.equal(phaseSessionCursorPreflight(expected, exported).state, "blocked");
});
test("the real publication guard rejects a forged ready cursor envelope before DB access", async t => {
  const { exported, expected } = await fixture(), report = verifyPhaseSessionCursor(expected, exported);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error("DB forbidden"); };
  t.mock.method(Pool.prototype, "query", forbidden as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", forbidden as unknown as typeof Pool.prototype.connect);
  const checkpoint: ContinuationCheckpoint = { unit: report.unit, kind: report.unit, inputHash: report.recordHash, pipeline: 2, format: 1,
    state: "ready", sourceRunId: "fixture-run", result: report, resultHash: continuationHash(report) };
  await assert.rejects(publishContinuationCheckpoint("fixture", { generation: 1, runId: "fixture-run" }, checkpoint), /ready publication blocked: unit validators/);
  assert.throws(requireContinuationEnabled, /Continuation disabled/);
  assert.equal(calls, 0);
});
test("saved messages match the real privacy projection while original audit JSON stays intact", async () => {
  const supplied = record(); Object.assign(supplied[6], { original: { text: "Audit original." }, translation: { text: "Audit translation." } });
  const { exported, expected } = await fixture("debate", "decision", 2, supplied);
  assert.deepEqual(verifyPhaseSessionCursor(expected, exported).turns[1].visibleSeqs, [7, 8]);
  const body = exported.session as PhaseSessionExport;
  assert.ok(!body.body.messages.at(-1)!.content.toString().includes("Audit original"));
  assert.ok(JSON.stringify(exported.record).includes("Audit original"));
  const reordered = JSON.parse(JSON.stringify(exported)) as PhaseSessionCursorExport;
  reordered.record = reordered.record.map(e => Object.fromEntries(Object.entries(e).reverse())) as typeof reordered.record;
  assert.deepEqual(verifyPhaseSessionCursor(expected, reordered), verifyPhaseSessionCursor(expected, exported));
});
test("pins reject record, session generation/revision, task and input changes without normalizing them", async () => {
  const { exported, expected } = await fixture();
  const changed = structuredClone(exported); changed.record[0].judgeModel = "changed";
  assert.throws(() => verifyPhaseSessionCursor(expected, changed), /hash mismatch/);
  const origin = structuredClone(exported); (origin.session as PhaseSessionExport).origin.generation = 1;
  assert.throws(() => verifyPhaseSessionCursor({ ...expected, evidenceHash: continuationHash(origin) }, origin), /mismatch/);
  const revised = structuredClone(exported); (revised.session as PhaseSessionExport).revision++;
  assert.throws(() => verifyPhaseSessionCursor({ ...expected, evidenceHash: continuationHash(revised) }, revised), /revision mismatch/);
  const body = structuredClone(exported), state = (body.session as PhaseSessionExport).body;
  const index = Object.values(state.turns)[0].start - 1, message = JSON.parse(state.messages[index].content as string);
  message.task += " "; state.messages[index].content = JSON.stringify(message);
  assert.throws(() => verifyPhaseSessionCursor(repin(body, expected), body), /events\/task mismatch/);
});
test("gaps, duplicate seq/openings and Quick/unknown discriminators fail closed even with fresh hashes", async () => {
  const { exported, expected } = await fixture();
  for (const patch of [{ seq: 99 }, { seq: 1 }, { type: "session_opened" }, { type: "quick_response" }, { type: "future_event" }]) {
    const other = structuredClone(exported); Object.assign(other.record[3], patch);
    assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other));
  }
  assert.throws(() => verifyPhaseSessionCursor({ ...expected, mode: "quick" }, exported));
  for (const pipeline of [1, 6]) {
    const other = structuredClone(exported); Object.assign((other.session as PhaseSessionExport).origin, { pipeline });
    assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other));
  }
});
test("omitted/injected begin events, extra keys and non-text messages cannot pass fresh envelope hashes", async () => {
  const { exported, expected } = await fixture();
  for (const change of [(c: Record<string, unknown>) => { c.events = []; }, (c: Record<string, unknown>) => { c.events = record(); }, (c: Record<string, unknown>) => { c.extra = true; }, (c: Record<string, unknown>) => { c.task = '{"task":"wrong","preparation":"draft"}'; }]) {
    const other = structuredClone(exported), body = (other.session as PhaseSessionExport).body;
    const index = Object.values(body.turns)[0].start - 1;
    const content = JSON.parse(body.messages[index].content as string); change(content);
    body.messages[index].content = JSON.stringify(content);
    assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other), /events\/task mismatch/);
  }
  const other = structuredClone(exported), body = (other.session as PhaseSessionExport).body;
  body.messages[Object.values(body.turns)[0].start - 1].content = [{ type: "text", text: "Not the begin contract." }];
  assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other), /JSON text/);
});
test("cursor ahead/behind, regressing prefix and incomplete/duplicate/reordered ledger fail closed", async () => {
  const { exported, expected } = await fixture();
  for (const cursor of [0, 7, 9]) {
    const other = structuredClone(exported); (other.session as PhaseSessionExport).body.cursor = cursor;
    assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other), /saved cursor/);
  }
  for (const turns of [expected.turns.slice(1), [...expected.turns, expected.turns[0]], [...expected.turns].reverse(), expected.turns.map((t, i) => i ? { ...t, recordLength: 2 } : t), expected.turns.map(t => ({ ...t, recordLength: 9 }))]) assert.throws(() => verifyPhaseSessionCursor({ ...expected, turns }, exported));
  const duplicate = structuredClone(exported), body = (duplicate.session as PhaseSessionExport).body;
  const [first, last] = Object.values(body.turns); last.start = first.start; body.activeTurn = structuredClone(last);
  assert.throws(() => verifyPhaseSessionCursor(repin(duplicate, expected), duplicate), /unique turn ledger/);
});
test("duplicate message/wrapper JSON keys cannot be normalized away even with independently repinned bytes", async () => {
  const { exported, expected } = await fixture();
  for (const wrapper of [false, true]) {
    const other = structuredClone(exported), body = (other.session as PhaseSessionExport).body;
    const index = Object.values(body.turns)[0].start - 1, pins = structuredClone(expected);
    if (wrapper) {
      const content = JSON.parse(body.messages[index].content as string);
      content.task = '{"preparation":"unproved",' + content.task.slice(1);
      pins.turns[0].taskHash = continuationHash(content.task);
      body.messages[index].content = JSON.stringify(content);
    } else body.messages[index].content = (body.messages[index].content as string).replace('{"events":', '{"events":[],"events":');
    assert.throws(() => verifyPhaseSessionCursor(repin(other, pins), other), /lossless JSON serialization/);
  }
});
test("exact legacy spec/attempt/seq ID and phase/seat pins cannot be replaced by plausible hashes", async () => {
  const { exported, expected } = await fixture();
  for (const patch of [{ attempt: 1 }, { specJson: '{"kind":"intake"}' }, { specJson: '{"kind":"statement","counsel":"gemini","stage":"opening"}' }, { specJson: '{"kind":"statement","counsel":"grok","stage":"opening","extra":true}' }, { specJson: ' {"kind":"statement","counsel":"grok","stage":"opening"}' }, { specJson: '{"stage":"opening","counsel":"grok","kind":"statement"}' }]) {
    const turns = structuredClone(expected.turns); Object.assign(turns[0], patch);
    assert.throws(() => verifyPhaseSessionCursor({ ...expected, turns }, exported));
  }
});
test("missing/duplicate/future closing boundaries never start debate by approximation", async () => {
  const { exported, expected } = await fixture();
  for (const change of [(e: PhaseSessionCursorExport) => { e.record[4].type = "instruction_opened"; }, (e: PhaseSessionCursorExport) => { e.record[7].type = "instruction_closed"; }, (e: PhaseSessionCursorExport) => { e.record[4].extra = true; }]) {
    const other = structuredClone(exported); change(other);
    assert.throws(() => verifyPhaseSessionCursor(repin(other, expected), other), /boundary|before instruction/);
  }
});
test("in-flight/expired and lost active-turn markers remain blocked rather than becoming reusable", async () => {
  const { exported, expected } = await fixture();
  const body = (exported.session as PhaseSessionExport).body, turn = Object.values(body.turns).at(-1)!;
  turn.inFlightStep = `decision:${body.id}:${turn.id}:${turn.steps}`; delete body.activeTurn;
  const pins = repin(exported, expected); (pins.session as PhaseSessionExpectation).observedAt = "2030-01-01T00:00:00.000Z";
  const report = verifyPhaseSessionCursor(pins, exported);
  assert.equal(report.recordedTurns.at(-1)!.status, "unresolved"); assert.equal(report.recordedTurns.at(-1)!.deadlineElapsed, true);
  assert.equal(phaseSessionCursorPreflight(pins, exported).state, "blocked");
});
test("hostile JSON and oversized evidence are rejected before accessors/proxy hooks run", async () => {
  const { exported, expected } = await fixture(); let invoked = 0;
  const accessor = structuredClone(exported); Object.defineProperty(accessor, "record", { enumerable: true, get() { invoked++; throw new Error("getter"); } });
  const proxy = new Proxy(exported, { ownKeys() { invoked++; throw new Error("proxy"); } });
  const sparse = structuredClone(exported); delete sparse.record[1];
  const hidden = structuredClone(exported); Object.defineProperty(hidden, "hidden", { value: true });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let deep: unknown = {}; for (let i = 0; i < 34; i++) deep = { nested: deep };
  for (const invalid of [accessor, proxy, sparse, hidden, cycle, deep, { text: "x".repeat(8_000_001) }, { array: Array(100_001).fill(null) }, { bad: Infinity }]) assert.throws(() => verifyPhaseSessionCursor(expected, invalid));
  assert.equal(invoked, 0);
  const failed = phaseSessionCursorPreflight(expected, { secret: "Never expose this prose." });
  assert.equal(failed.state, "blocked"); assert.ok(!JSON.stringify(failed).includes("Never expose"));
});
