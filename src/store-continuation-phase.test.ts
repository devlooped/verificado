// Actual store SQL functions with a transactional DOUBLE, not PostgreSQL proof.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { retainContinuationPhaseSnapshot, loadContinuationPhaseSnapshot, loadPhaseCheckpoint, savePhaseCheckpoint } from "./store.ts";
import { continuationHash, continuationJson, CONTINUATION_ENABLED } from "./domain/continuation.ts";
import type { ContinuationPhaseSnapshot } from "./domain/continuation-phase.ts";
import { PhaseSession, MemoryPhaseRepository } from "./court/phase-session.ts";
import type { RecordedEvent } from "./domain/court.ts";

function database(t: TestContext) {
  const env = process.env.DATABASE_URL; process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (env === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = env; });
  const row = { id: "fixture", continuation_generation: 1, workflow_run_id: "run", status: "in_session", stopped_workflow_run_id: null as string | null };
  const generation = { state: "running", run_id: "run", reconciled_run_id: "run" };
  const state = { phases: new Map<string, Record<string, unknown>>(), audit: new Map<string, string>() };
  const events: RecordedEvent[] = [{ type: "session_opened", judgeModel: "fixture/model", counselModels: { grok: "fixture/model", gemini: "fixture/model", claude: "fixture/model", chatgpt: "fixture/model" }, seq: 1, at: "2026-11-07T12:00:00.000Z" }];
  const legacy = new Map<string, unknown>();
  const faults = { audit: false, cas: false, commit: false, eventBody: false };
  const calls: string[] = []; let queue = Promise.resolve(), releases = 0;
  const query = (sql: string, args: unknown[] = [], pending = state) => {
    calls.push(sql);
    if (sql.startsWith("SELECT id, continuation_generation")) return { rows: row.id ? [{ ...row }] : [] };
    if (sql.startsWith("SELECT state, run_id, reconciled_run_id")) return { rows: [{ ...generation }] };
    const key = JSON.stringify(args.slice(0, 3));
    if (sql.startsWith("SELECT case_id, generation, session_key")) return { rows: pending.phases.has(key) ? [structuredClone(pending.phases.get(key))] : [] };
    if (sql.startsWith("SELECT seq, at, body FROM events")) return { rows: events.filter(e => e.seq <= Number(args[1])).map(({ seq, at, ...body }) => ({ seq, at, body: faults.eventBody ? { ...body, seq: 999 } : body })) };
    if (sql.startsWith("INSERT INTO case_continuation_phase_states")) {
      if (pending.phases.has(key) || faults.cas) return { rowCount: 0 };
      pending.phases.set(key, { case_id: args[0], generation: args[1], session_key: args[2], run_id: args[3], revision: 0, body: JSON.parse(String(args[4])), body_hash: args[5] }); return { rowCount: 1 };
    }
    if (sql.startsWith("UPDATE case_continuation_phase_states")) {
      const value = pending.phases.get(key); if (!value || value.revision !== args[3] || faults.cas) return { rowCount: 0 };
      pending.phases.set(key, { ...value, revision: Number(value.revision) + 1, body: JSON.parse(String(args[4])), body_hash: args[5] }); return { rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO case_continuation_audit")) {
      if (faults.audit) throw new Error("Audit fault");
      const value = String(args[3]); if (pending.audit.has(key) && pending.audit.get(key) !== value) return { rowCount: 0 };
      pending.audit.set(key, value); return { rowCount: 1 };
    }
    if (sql.startsWith("SELECT body FROM case_continuation_audit")) return { rows: pending.audit.has(key) ? [{ body: JSON.parse(pending.audit.get(key)!) }] : [] };
    if (sql.startsWith("SELECT revision, body FROM case_phase_sessions")) return { rows: legacy.has(String(args[1])) ? [{ revision: 0, body: structuredClone(legacy.get(String(args[1]))) }] : [] };
    throw new Error("Unexpected SQL: " + sql);
  };
  t.mock.method(Pool.prototype, "query", (async (sql: string, args?: unknown[]) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS cases")) return { rows: [] };
    if (sql.startsWith("SELECT case_id, seq, body FROM events")) return { rows: [] }; // Existing bootstrap migration only.
    return query(sql, args);
  }) as unknown as typeof Pool.prototype.query);
  const connect = async () => {
    let pending: typeof state | undefined, unlock: (() => void) | undefined;
    const finish = () => { unlock?.(); unlock = undefined; pending = undefined; };
    return { async query(sql: string, args?: unknown[]) {
      if (sql === "BEGIN") { const previous = queue; queue = new Promise<void>(resolve => { unlock = resolve; }); await previous; pending = structuredClone(state); calls.push(sql); return { rows: [] }; }
      if (sql === "COMMIT") { assert.ok(pending); Object.assign(state, pending); calls.push(sql); finish(); if (faults.commit) { faults.commit = false; throw new Error("COMMIT response lost"); } return { rows: [] }; }
      if (sql === "ROLLBACK") { calls.push(sql); finish(); return { rows: [] }; }
      assert.ok(pending); return query(sql, args, pending);
    }, release() { releases++; finish(); } };
  };
  t.mock.method(Pool.prototype, "connect", connect as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  return { row, generation, state, events, legacy, faults, calls, connect, releases: () => releases };
}
async function fixture(t: TestContext) {
  const db = database(t), writer = { generation: 1, runId: "run" }, key = "intake:judge:decision";
  const session = await PhaseSession.open("fixture", { phase: "intake", seat: "judge", channel: "decision", model: { id: "fixture/model" }, system: "Pinned system", tools: "{}", initial: "Pinned original" }, new MemoryPhaseRepository());
  const snapshot = (): ContinuationPhaseSnapshot => ({ schemaVersion: 1, status: "blocked", caseId: "fixture", ...writer, deploymentId: "deployment", pipeline: 2, sessionKey: key,
    recordHash: continuationHash(db.events.slice(0, session.state.cursor)), body: structuredClone(session.state) as ContinuationPhaseSnapshot["body"] });
  const begin = async () => { await session.begin("turn", db.events, "Pinned task"); return snapshot(); };
  const save = (revision: number, value: unknown = snapshot()) => retainContinuationPhaseSnapshot("fixture", writer, revision, value);
  const load = () => loadContinuationPhaseSnapshot("fixture", writer, key);
  const stored = () => db.state.phases.get(JSON.stringify(["fixture", 1, key]))!;
  return { ...db, writer, key, session, snapshot, begin, save, load, stored };
}

test("real store retains blocked PhaseSession state, committed cursor and audit without a runtime adapter", async t => {
  const f = await fixture(t); assert.equal(await f.save(-1), 0);
  const next = await f.begin(); assert.equal(await f.save(0, next), 1);
  const retained = await f.load(); assert.equal(retained?.revision, 1); assert.deepEqual(retained?.snapshot, next);
  assert.equal(retained?.snapshot.status, "blocked"); assert.equal(Object.hasOwn(retained!, "body"), false);
  assert.equal(f.state.audit.size, 2); assert.equal(CONTINUATION_ENABLED, false);
  assert.ok(f.calls.indexOf("BEGIN") < f.calls.findIndex(s => s.includes("FOR UPDATE")));
  await assert.rejects(savePhaseCheckpoint("fixture", f.key, 0, next.body, f.writer), /atomic checkpoint/);
});
test("simultaneous create/CAS candidates have one winner; identical retry is idempotent", async t => {
  const f = await fixture(t), initial = f.snapshot(), different = structuredClone(initial); different.body.system = "Another configuration";
  const results = await Promise.allSettled([f.save(-1, initial), f.save(-1, different)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.state.phases.size, 1);
  assert.equal(await f.save(-1, initial), 0); assert.equal(f.state.audit.size, 1);
  const next = await f.begin(), other = structuredClone(next); other.body.messages.push({ role: "assistant", content: "Different candidate" });
  const updates = await Promise.allSettled([f.save(0, next), f.save(0, other)]);
  assert.equal(updates.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.stored().revision, 1);
  await assert.rejects(f.save(0, other), /Concurrent/);
});
test("lost COMMIT response preserves the exact durable revision and does not duplicate audit or budgets", async t => {
  const f = await fixture(t), value = await f.begin(); f.faults.commit = true;
  await assert.rejects(f.save(-1, value), /COMMIT response lost/);
  assert.equal(await f.save(-1, value), 0); assert.equal(f.state.audit.size, 1);
  assert.deepEqual((await f.load())?.snapshot.body.turns, value.body.turns);
  assert.ok(f.releases() >= 3);
});
test("audit faults/collisions and SQL CAS failure roll back snapshot and revision atomically", async t => {
  const f = await fixture(t); await f.save(-1); const next = await f.begin(), before = structuredClone(f.state);
  f.faults.audit = true; await assert.rejects(f.save(0, next), /Audit fault/); assert.deepEqual(f.state, before); f.faults.audit = false;
  const auditKey = JSON.stringify(["fixture", 1, `phase-state:v1:${continuationHash(f.key)}:1`]); f.state.audit.set(auditKey, "conflicting audit");
  const collided = structuredClone(f.state); await assert.rejects(f.save(0, next), /audit collision/); assert.deepEqual(f.state, collided);
  f.state.audit.delete(auditKey); f.faults.cas = true; await assert.rejects(f.save(0, next), /CAS lost/); assert.deepEqual(f.state, before);
});
test("missing/invalid writers and namespace/CAS/envelope errors reject before DB, with no legacy fallback", async t => {
  const f = await fixture(t), value = f.snapshot(), before = f.calls.length;
  for (const writer of [undefined, null, { generation: 0, runId: "run" }, { generation: 1, runId: "" }, { generation: 1, runId: "run", extra: true }]) {
    await assert.rejects(retainContinuationPhaseSnapshot("fixture", writer as typeof f.writer, -1, value));
    await assert.rejects(loadContinuationPhaseSnapshot("fixture", writer as typeof f.writer, f.key));
  }
  for (const revision of [-2, 1.5, 2147483646]) await assert.rejects(f.save(revision));
  for (const patch of [{ status: "ready" }, { generation: 2 }, { runId: "other" }, { sessionKey: "generation:1:" + f.key }, { pipeline: 1 }, { extra: true }]) await assert.rejects(f.save(-1, { ...value, ...patch }));
  await assert.rejects(loadPhaseCheckpoint("fixture", "generation:1:" + f.key), /writer required/);
  await assert.rejects(savePhaseCheckpoint("fixture", "generation:1:" + f.key, -1, {}), /writer required/);
  assert.equal(f.calls.length, before);
});
test("stale generations/runs, unreconciled starts and terminal/cancelled cases fence reads and writes", async t => {
  const f = await fixture(t); await f.save(-1); const before = structuredClone(f.state);
  for (const patch of [{ continuation_generation: 2 }, { workflow_run_id: "other" }, { status: "failed" }, { stopped_workflow_run_id: "run" }]) {
    const old = { ...f.row }; Object.assign(f.row, patch);
    await assert.rejects(f.load(), /fenced/); await assert.rejects(f.save(0), /fenced/); Object.assign(f.row, old);
  }
  for (const patch of [{ state: "uncertain" }, { run_id: "other" }, { reconciled_run_id: null }]) {
    const old = { ...f.generation }; Object.assign(f.generation, patch);
    await assert.rejects(f.load(), /fenced/); await assert.rejects(f.save(0), /fenced/); Object.assign(f.generation, old);
  }
  assert.deepEqual(f.state, before);
});
test("waiting writers observe committed generation/cancellation before any phase access (SQL double)", async t => {
  const f = await fixture(t); await f.save(-1); const before = structuredClone(f.state);
  for (const cancel of [false, true]) {
    const controller = await f.connect(); await controller.query("BEGIN");
    const waiting = [f.save(0), f.load()];
    if (cancel) f.row.stopped_workflow_run_id = "run"; else f.row.continuation_generation = 2;
    await controller.query("COMMIT"); controller.release();
    assert.ok((await Promise.allSettled(waiting)).every(r => r.status === "rejected" && /fenced/.test(String(r.reason))));
    f.row.continuation_generation = 1; f.row.stopped_workflow_run_id = null;
  }
  assert.deepEqual(f.state, before);
});
test("legacy reads stay read-only on terminal cases; explicit generation reads now use fencing", async t => {
  const f = await fixture(t); f.legacy.set(f.key, { original: true }); f.legacy.set("generation:1:" + f.key, { cursor: 12 });
  assert.deepEqual(await loadPhaseCheckpoint("fixture", f.key, f.writer), { revision: 0, body: { cursor: 12 } });
  f.row.status = "failed"; await assert.rejects(loadPhaseCheckpoint("fixture", f.key, f.writer), /fenced/);
  assert.deepEqual(await loadPhaseCheckpoint("fixture", f.key), { revision: 0, body: { original: true } });
});
test("column/body/hash/revision corruption blocks load and retry without repairs", async t => {
  const f = await fixture(t); await f.save(-1); const valid = structuredClone(f.stored());
  for (const patch of [{ case_id: "other" }, { generation: 2 }, { run_id: "other" }, { session_key: "other" }, { revision: -1 }, { body_hash: "wrong" }, { body: null }]) {
    Object.assign(f.stored(), patch); const before = structuredClone(f.state);
    await assert.rejects(f.load()); await assert.rejects(f.save(-1)); assert.deepEqual(f.state, before); Object.assign(f.stored(), valid);
  }
});
test("committed prefix gaps, changes and cursor not backed by begin never become durable", async t => {
  const f = await fixture(t), value = await f.begin();
  const bad = structuredClone(value); bad.recordHash = continuationHash([]); await assert.rejects(f.save(-1, bad), /prefix mismatch/);
  f.events[0].seq = 2; await assert.rejects(f.save(-1, value), /prefix mismatch/); f.events[0].seq = 1;
  f.faults.eventBody = true; await assert.rejects(f.save(-1, value), /corrupt committed event/); f.faults.eventBody = false;
  await f.save(-1, value); f.events[0].at = "changed"; await assert.rejects(f.load(), /corrupt committed event/);
});
test("missing/corrupt durable audit cannot be silently accepted by load or exact retry", async t => {
  const f = await fixture(t); await f.save(-1); const audit = [...f.state.audit][0];
  f.state.audit.delete(audit[0]); await assert.rejects(f.load(), /audit missing/); await assert.rejects(f.save(-1), /audit missing/);
  f.state.audit.set(audit[0], '{"wrong":true}'); await assert.rejects(f.load(), /audit missing\/corrupt/);
  f.state.audit.set(...audit); assert.equal((await f.load())?.revision, 0);
});
test("configuration/bindings, history, cursor and original budgets cannot be reset", async t => {
  const f = await fixture(t), value = await f.begin(); await f.save(-1, value); const before = structuredClone(f.state);
  for (const change of [(s: ContinuationPhaseSnapshot) => { s.body.system = "changed"; }, (s: ContinuationPhaseSnapshot) => { s.body.sandboxId = "replacement"; }, (s: ContinuationPhaseSnapshot) => { s.body.messages[0].content = "replacement"; }, (s: ContinuationPhaseSnapshot) => { s.body.turns.turn.expiresAt = new Date(Date.parse(s.body.turns.turn.expiresAt) + 1000).toISOString(); s.body.activeTurn = structuredClone(s.body.turns.turn); }, (s: ContinuationPhaseSnapshot) => { delete s.body.turns.turn; delete s.body.activeTurn; }]) {
    const other = structuredClone(value); change(other); await assert.rejects(f.save(0, other)); assert.deepEqual(f.state, before);
  }
  const reset = structuredClone(value); reset.body.cursor = 0; reset.recordHash = continuationHash([]); await assert.rejects(f.save(0, reset));
});
test("incomplete or lost-effect markers are retained without clearing or permitting a new turn", async t => {
  const f = await fixture(t), value = await f.begin();
  value.body.turns.turn.inFlightStep = `decision:${value.body.id}:turn:0`; value.body.activeTurn = structuredClone(value.body.turns.turn);
  await f.save(-1, value);
  const cleared = structuredClone(value); delete cleared.body.turns.turn.inFlightStep; cleared.body.activeTurn = structuredClone(cleared.body.turns.turn);
  await assert.rejects(f.save(0, cleared), /effect marker/);
  const abandoned = structuredClone(value); delete abandoned.body.activeTurn; await assert.rejects(f.save(0, abandoned), /abandoned/);
});
test("valid-looking renewed budgets, new turns and completed result rewrites still fail closed", async t => {
  const f = await fixture(t), value = await f.begin(); await f.save(-1, value);
  const reset = structuredClone(value), turn = reset.body.turns.turn;
  turn.startedAt = new Date(Date.parse(turn.startedAt) + 1000).toISOString(); turn.expiresAt = new Date(Date.parse(turn.expiresAt) + 1000).toISOString(); reset.body.activeTurn = structuredClone(turn);
  await assert.rejects(f.save(0, reset), /budget\/identity reset/);
  const added = structuredClone(value); added.body.turns.second = { ...structuredClone(added.body.turns.turn), id: "second", start: added.body.messages.length + 1 };
  added.body.messages.push({ role: "user", content: JSON.stringify({ events: [], task: "Must not start another budget" }) }); added.body.activeTurn = structuredClone(added.body.turns.second);
  await assert.rejects(f.save(0, added), /multiple incomplete|prior outcome unresolved/);
  const completed = structuredClone(value); completed.body.turns.turn.complete = true; completed.body.turns.turn.done = true; completed.body.turns.turn.results.tool = { input: "{}", output: { exact: true } }; delete completed.body.activeTurn;
  completed.body.messages.push({ role: "user", content: JSON.stringify({ events: [], task: "Old provider feedback, not a new begin" }) });
  await f.save(0, completed);
  const changed = structuredClone(completed); changed.body.turns.turn.results.tool.output = { exact: false };
  await assert.rejects(f.save(1, changed), /completed turn changed/);
  const reused = structuredClone(completed); reused.body.turns.second = { ...structuredClone(reused.body.turns.turn), id: "second", start: reused.body.messages.length, steps: 0, done: false, complete: false, events: [], results: {} }; reused.body.activeTurn = structuredClone(reused.body.turns.second);
  await assert.rejects(f.save(1, reused), /existing message\/budget frame/);
  assert.equal((await f.load())?.snapshot.status, "blocked", "completion flags do not promote a retained snapshot");
});
test("caller mutation and hostile JSON cannot change captured intention or invoke hooks", async t => {
  const f = await fixture(t), value = f.snapshot(), original = structuredClone(value);
  t.mock.method(Date, "now", () => { throw new Error("Storage must not renew a budget or audit timestamp"); });
  const owner = { ...f.writer };
  const saving = retainContinuationPhaseSnapshot("fixture", owner, -1, value);
  value.body.system = "mutated after call"; owner.generation = 2; owner.runId = "mutated writer"; await saving;
  assert.deepEqual((await f.load())?.snapshot, original);
  let invoked = 0;
  const proxy = new Proxy(original, { ownKeys() { invoked++; throw new Error("proxy"); } });
  const getter = structuredClone(original); Object.defineProperty(getter, "body", { enumerable: true, get() { invoked++; throw new Error("getter"); } });
  for (const bad of [proxy, getter, { ...original, hidden: undefined }]) await assert.rejects(f.save(0, bad));
  assert.equal(invoked, 0); assert.equal(continuationJson((await f.load())?.snapshot), continuationJson(original));
});
