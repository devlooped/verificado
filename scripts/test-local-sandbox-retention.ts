import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { Sandbox } from "@vercel/sandbox";
import { Pool } from "pg";
import { LOCAL_DATABASE, requireLocalDatabase } from "../src/lib/local-database.ts";
import type { SandboxBinding } from "../src/instruction/authorization.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const connectionString = requireLocalDatabase(); // Reject remote/fallback before store import.
const sql = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000 });
let external = 0;
const forbidden = async () => { external++; throw new Error("External fixture effect forbidden"); };
const fetch = globalThis.fetch, get = Sandbox.get, list = Sandbox.list;
globalThis.fetch = forbidden;
Sandbox.get = forbidden as typeof Sandbox.get;
Sandbox.list = forbidden as typeof Sandbox.list;
const ids: string[] = [];
try {
  const identity = await sql.query("SELECT current_database() AS db, current_user AS usr");
  assert.deepEqual(identity.rows[0], { db: LOCAL_DATABASE, usr: "grokeado" });
  const store = await import("../src/store.ts");
  const cleanup = await import("../src/instruction/preparation.ts");
  async function fixture() {
    const id = "fixture-retention-" + randomUUID();
    await store.createCase(id, { kind: "text", text: "Synthetic local retention fixture; no recovery or infrastructure." });
    ids.push(id);
    await sql.query("UPDATE cases SET status='in_session',pipeline_version=5,workflow_run_id='fixture-legacy' WHERE id=$1", [id]);
    return id;
  }
  const id = await fixture(), other = await fixture();
  const key = "instruction:grok:preparation", name = id + "-sandbox";
  const phase = { id: "phase-1", sandboxId: name, messages: ["durable"], cursor: 0 };
  const binding: SandboxBinding = { phase: "instruction", seat: "grok", sessionKey: key, phaseSessionId: phase.id, expiresAt: "2000-01-01T00:00:00Z", revoked: false, model: { id: "fixture/model" }, gatewayTools: [] };
  await store.savePhaseCheckpoint(id, key, -1, phase);
  await store.saveSandboxBinding(id, name, binding);
  await store.saveSandboxBinding(id, name, binding); // Safe same-owner legacy replay.
  await assert.rejects(store.saveSandboxBinding(other, name, binding), /cannot be reassigned/);
  await assert.rejects(store.saveSandboxBinding(id, name, { ...binding, sessionKey: "other-session" }), /cannot be reassigned/);
  for (const body of [{ ...phase, sandboxId: "different" }, { id: phase.id }, { ...phase, id: "replacement" }]) {
    await assert.rejects(store.savePhaseCheckpoint(id, key, 0, body), /Concurrent phase-session/);
    assert.deepEqual(await store.loadPhaseCheckpoint(id, key), { revision: 0, body: phase });
  }
  const saves = await Promise.allSettled([1, 2].map(cursor => store.savePhaseCheckpoint(id, key, 0, { ...phase, cursor })));
  assert.equal(saves.filter(result => result.status === "fulfilled").length, 1);
  const retained = await store.loadPhaseCheckpoint(id, key);
  assert.equal(retained?.revision, 1);
  assert.equal((retained?.body as typeof phase).sandboxId, name);

  // Hold the terminal transition uncommitted while late writers start. NOWAIT
  // proves the real case lock; no sleep, lease or cancellation inference.
  const lock = await sql.connect();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [id]);
    await lock.query("UPDATE cases SET status='failed',stopped_workflow_run_id='fixture-cancelled' WHERE id=$1", [id]);
    await assert.rejects(sql.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT", [id]), error => (error as { code?: string }).code === "55P03");
    pending = Promise.allSettled([
      store.savePhaseCheckpoint(id, key, 1, { ...phase, cursor: 3 }),
      store.saveSandboxBinding(id, name, { ...binding, expiresAt: "2099-01-01T00:00:00Z" }),
    ]);
    await assert.rejects(cleanup.deleteCaseSandboxes(id), cleanup.SandboxCleanupBlockedError);
    assert.deepEqual(await cleanup.sweepCaseSandboxes(), []);
    await lock.query("COMMIT");
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  const late = await pending!;
  assert.ok(late.every(result => result.status === "rejected" && /writer blocked/.test(String(result.reason))));
  assert.deepEqual(await store.loadPhaseCheckpoint(id, key), retained);
  assert.deepEqual((await sql.query("SELECT body FROM case_sandbox_bindings WHERE sandbox_id=$1", [name])).rows[0].body, binding);
  await store.revokeSandboxBindings(id);
  assert.deepEqual(await store.caseSandboxNames(id), [name]);
  await assert.rejects(cleanup.deleteCaseSandboxes(id), cleanup.SandboxCleanupBlockedError);

  // Exercise the real durable PhaseSession adapter, not the memory repository.
  // Legacy active replay retains its ID, VM, messages, budget and turn clock.
  const { PhaseSession } = await import("../src/court/phase-session.ts");
  const legacy = await fixture();
  const initial = { phase: "intake" as const, seat: "judge" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "Synthetic", tools: "[]", initial: "Synthetic" };
  let session = await PhaseSession.open(legacy, initial);
  const turn = await session.begin("partial", [], "Synthetic");
  session.state.sandboxId = legacy + "-vm";
  await session.append([{ role: "assistant", content: "Synthetic retained prefix" }]);
  const prefix = structuredClone(session.state);
  session = await PhaseSession.open(legacy, initial);
  await session.begin("partial", [], "Ignored retry task");
  assert.deepEqual(session.state, prefix, "active replay neither resets nor replenishes the existing turn");
  assert.equal(session.state.activeTurn?.expiresAt, turn.expiresAt);
  await assert.rejects(PhaseSession.open(legacy, { ...initial, system: "Changed" }), /configuration changed/);
  const partialCheckpoint = await store.loadPhaseCheckpoint(legacy, session.key);
  for (const status of ["queued", "failed", "resolved"] as const) {
    await sql.query("UPDATE cases SET status=$2 WHERE id=$1", [legacy, status]);
    const replay = await PhaseSession.open(legacy, initial);
    await assert.rejects(replay.begin("partial", [], "Ignored"), /writer blocked/, "an incomplete terminal replay cannot advance its checkpoint");
    assert.deepEqual(await store.loadPhaseCheckpoint(legacy, session.key), partialCheckpoint);
    await assert.rejects(PhaseSession.open(legacy, { ...initial, seat: "grok" }), /writer blocked/, "missing terminal checkpoints do not authorize recreating a session");
    assert.equal(await store.loadPhaseCheckpoint(legacy, "intake:grok:preparation"), undefined);
  }
  await sql.query("UPDATE cases SET status='in_session' WHERE id=$1", [legacy]);
  await session.finish();
  const completed = await store.loadPhaseCheckpoint(legacy, session.key);
  for (const status of ["queued", "failed", "resolved"] as const) {
    await sql.query("UPDATE cases SET status=$2 WHERE id=$1", [legacy, status]);
    const replay = await PhaseSession.open(legacy, initial);
    assert.equal((await replay.begin("partial", [], "Ignored")).complete, true);
    assert.deepEqual(await store.loadPhaseCheckpoint(legacy, session.key), completed, "completed turn replay is read-only even on a terminal case");
    await assert.rejects(replay.save(), /writer blocked/, "even identical terminal saves are intentionally blocked; no CAS revision advance");
    await assert.rejects(replay.begin("new-turn", [], "Unsafe"), /writer blocked/);
    assert.deepEqual(await store.loadPhaseCheckpoint(legacy, session.key), completed);
  }
  await sql.query("UPDATE cases SET status='in_session' WHERE id=$1", [legacy]);
  const legacyName = legacy + "-binding";
  // Pre-guard rows lacking ownership or already revoked are not repaired by
  // guessing. The same populated, nonrevoked owner replay is covered above.
  for (const old of [{ ...binding, revoked: true }, { ...binding, sessionKey: undefined }, { ...binding, phaseSessionId: undefined }]) {
    await sql.query("INSERT INTO case_sandbox_bindings (case_id,sandbox_id,body) VALUES ($1,$2,$3) ON CONFLICT (sandbox_id) DO UPDATE SET body=EXCLUDED.body", [legacy, legacyName, JSON.stringify(old)]);
    await assert.rejects(store.saveSandboxBinding(legacy, legacyName, binding), /cannot be reassigned or unrevoked/);
    assert.deepEqual((await sql.query("SELECT body FROM case_sandbox_bindings WHERE sandbox_id=$1", [legacyName])).rows[0].body, JSON.parse(JSON.stringify(old)));
  }

  // Synthetic generation states only, never a real start or public activation.
  const generational = await fixture();
  async function generation(number: number) {
    const writer = { generation: number, runId: "fixture-run-" + number };
    await sql.query("UPDATE cases SET continuation_generation=$2,workflow_run_id=$3 WHERE id=$1", [generational, number, writer.runId]);
    await sql.query("INSERT INTO case_continuation_generations (case_id,generation,token,state,run_id,reconciled_run_id,body) VALUES ($1,$2,$3,'running',$4,$4,$5)", [generational, number, randomUUID(), writer.runId, JSON.stringify({ synthetic: true })]);
    return writer;
  }
  const first = await generation(1), firstName = generational + "-generation-1";
  await store.saveSandboxBinding(generational, firstName, { ...binding, writer: first }, first);
  const second = await generation(2), secondName = generational + "-generation-2";
  await assert.rejects(store.saveSandboxBinding(generational, firstName, { ...binding, writer: second }, second), /cannot be reassigned/);
  await assert.rejects(store.revokeSandboxBindings(generational, undefined, first), /fenced/);
  await assert.rejects(store.saveSandboxBinding(generational, firstName, binding), /fenced/);
  await store.saveSandboxBinding(generational, secondName, { ...binding, writer: second }, second);
  await store.revokeSandboxBindings(generational, undefined, second);
  const grants = (await sql.query("SELECT sandbox_id,body FROM case_sandbox_bindings WHERE case_id=$1 ORDER BY sandbox_id", [generational])).rows;
  assert.equal(grants.find(row => row.sandbox_id === firstName).body.revoked, false);
  assert.equal(grants.find(row => row.sandbox_id === secondName).body.revoked, true);
  await assert.rejects(cleanup.deleteCaseSandboxes(generational), cleanup.SandboxCleanupBlockedError);
  assert.deepEqual(await cleanup.sweepCaseSandboxes(), []);
  assert.equal(external, 0);
  console.log("PASS: guarded local PostgreSQL terminal/late-writer serialization, immutable references, CAS race/rollback, durable active/completed legacy phase replay, unsupported terminal/new/ambiguous binding replay blocked, generation-isolated revocation; cleanup/sweep blocked, zero providers/Blob/workflows.");
} finally {
  for (const id of ids) await sql.query("DELETE FROM cases WHERE id=$1", [id]);
  await sql.end();
  globalThis.fetch = fetch; Sandbox.get = get; Sandbox.list = list;
}
