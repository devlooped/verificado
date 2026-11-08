import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import nextEnv from "@next/env";
import { Pool, type PoolClient } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { setWorld } from "workflow/runtime";
import { requireLocalDatabase, LOCAL_DATABASE } from "../src/lib/local-database.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const connectionString = requireLocalDatabase(); // Before store/routes or any connection.
const sql = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000 });
const id = `fixture-rerun-${randomUUID()}`;
let external = 0;
const forbidden = async () => { external++; throw new Error("External fixture effect forbidden"); };
mock.method(globalThis, "fetch", forbidden);
mock.method(Sandbox, "get", forbidden);
mock.method(Sandbox, "list", forbidden);
mock.method(Sandbox, "create", forbidden);
// Deliberately incomplete World evidence: this fixture exercises only blockers.
setWorld({ specVersion: 8, runs: { get: async (runId: string) => ({ runId, status: "running" }) } } as unknown as Parameters<typeof setWorld>[0]);
try {
  assert.deepEqual((await sql.query("SELECT current_database() AS db, current_user AS usr")).rows[0], { db: LOCAL_DATABASE, usr: "grokeado" });
  const store = await import("../src/store.ts");
  const { PhaseSession } = await import("../src/court/phase-session.ts");
  const cleanup = await import("../src/instruction/preparation.ts");
  const { auth0 } = await import("../src/lib/auth0.ts");
  mock.method(auth0, "getSession", async () => ({ user: { sub: "fixture-admin", roles: ["Admin"] } }));
  const { DELETE } = await import("../src/app/api/cases/[id]/route.ts");
  const { POST } = await import("../src/app/api/cases/[id]/rerun/route.ts");
  const { SANDBOX_CLEANUP_BLOCKED_RESPONSE } = await import("../src/lib/sandbox-cleanup.ts");
  await store.createCase(id, { kind: "image", mimeType: "image/png", note: "Synthetic local fixture", language: "es" }, Buffer.from("synthetic image"), "fixture-owner");
  await store.openSession(id, 2);
  await store.saveCaseLanguage(id, "es");
  await store.saveCaseModels(id, { judge: { id: "fixture/model", effort: null } });
  await store.recordEvents(id, [{ type: "instruction_opened", seq: 1, at: new Date().toISOString() }]);
  await store.saveCover(id, { mimeType: "image/png", bytes: Buffer.from("synthetic cover"), generated: true });
  const claim = await store.sourceOperationRepository.claim(id, "fixture-operation", "acquisition", 30_000);
  assert.ok(claim.owned);
  await store.sourceOperationRepository.publish(id, "fixture-operation", claim.owner, { synthetic: true });
  await store.sourceOperationRepository.alias(id, "https://example.test/synthetic", "fixture-source");
  await store.saveCaseAuditRecord(id, "fixture-audit", { synthetic: true });
  const phase = await PhaseSession.open(id, { phase: "intake", seat: "judge", channel: "preparation", model: { id: "fixture/model" }, system: "Synthetic", tools: "[]", initial: "Synthetic" });
  await phase.begin("fixture-turn", [], "Synthetic");
  phase.state.sandboxId = id + "-private-vm"; await phase.save();
  await store.saveSandboxBinding(id, phase.state.sandboxId, { phase: "intake", seat: "judge", sessionKey: phase.key, phaseSessionId: phase.state.id, revoked: false, model: phase.state.model, gatewayTools: [], expiresAt: "2000-01-01T00:00:00Z" });
  await sql.query("INSERT INTO case_aliases (old_id,case_id) VALUES ($1,$2)", [id + "-alias", id]);

  // Compare all durable processing/reference rows, not merely the public status.
  async function snapshot(client: Pool | PoolClient = sql) {
    const result: Record<string, unknown> = { cases: (await client.query("SELECT to_jsonb(c) AS body FROM cases c WHERE id=$1", [id])).rows };
    for (const table of ["events", "images", "covers", "case_aliases", "case_source_operations", "case_source_aliases", "case_phase_sessions", "case_audit_records", "case_sandbox_bindings"]) {
      result[table] = (await client.query(`SELECT to_jsonb(t) AS body FROM ${table} t WHERE case_id=$1 ORDER BY to_jsonb(t)::text`, [id])).rows;
    }
    return result;
  }
  const context = { params: Promise.resolve({ id }) };
  const remove = () => DELETE(new Request(`https://example.test/api/cases/${id}`, { method: "DELETE", headers: { origin: "https://example.test" } }), context);
  const rerun = () => POST(new Request(`https://example.test/api/cases/${id}/rerun`, { method: "POST", headers: { origin: "https://example.test" } }), context);
  const artifacts = new Map([[id, "private synthetic artifact"], [id + "-alias", "private alias artifact"]]);
  const callback = cleanup.withSandboxCleanup(async () => { external++; artifacts.clear(); });

  // Real transaction lock held through terminal transition. Instrument only
  // query entry to prove both endpoint SELECTs start before lock release.
  for (const terminal of ["failed", "resolved"] as const) {
    await sql.query("UPDATE cases SET status='in_session',stopped_workflow_run_id=NULL WHERE id=$1", [id]);
    const lock = await sql.connect();
    const started = Promise.withResolvers<void>();
    let entries = 0;
    const connect = Pool.prototype.connect as () => Promise<PoolClient>;
    const hook = mock.method(Pool.prototype, "connect", async function (this: Pool, ...args: unknown[]) {
      // Pool.query internally uses callback connect; do not intercept the
      // independent fixture pool or change its overload contract.
      if (this === sql) return Reflect.apply(connect, this, args);
      const client = await connect.call(this);
      const query = client.query, release = client.release;
      client.query = function (this: PoolClient, ...args: unknown[]) {
        if (typeof args[0] === "string" && args[0].startsWith("SELECT status,") && args[0].includes("FOR UPDATE")) {
          if (++entries === 2) started.resolve();
        }
        return Reflect.apply(query, this, args);
      } as typeof client.query;
      client.release = function (...args: unknown[]) { client.query = query; client.release = release; return Reflect.apply(release, this, args); };
      return client;
    });
    let pending: Promise<Response[]> | undefined;
    let before: Record<string, unknown>;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [id]);
      await lock.query("UPDATE cases SET status=$2,stopped_workflow_run_id='fixture-cancelled' WHERE id=$1", [id, terminal]);
      before = await snapshot(lock);
      pending = Promise.all([remove(), rerun()]);
      await Promise.race([started.promise, pending.then(() => { throw new Error("Endpoint returned before entering the locked query"); })]);
      await assert.rejects(sql.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT", [id]), error => (error as { code?: string }).code === "55P03");
      await lock.query("COMMIT");
    } finally { await lock.query("ROLLBACK"); lock.release(); hook.mock.restore(); }
    const [deleted, restarted] = await pending!;
    assert.equal(deleted.status, 409);
    assert.deepEqual(await deleted.json(), SANDBOX_CLEANUP_BLOCKED_RESPONSE);
    assert.equal(restarted.status, 409);
    assert.match((await restarted.json()).error, /sigue en curso/);
    assert.deepEqual(await snapshot(), before!);
    const attempts = await Promise.allSettled([
      store.deleteCase(id, callback), store.restartCase(id, callback), store.requeueCase(id, callback),
      callback([id, id + "-alias"]), store.deleteCase(id, async () => { external++; }),
    ]);
    for (const [index, result] of attempts.entries()) {
      if (index === 1) { assert.equal(result.status, "fulfilled"); if (result.status === "fulfilled") assert.equal(result.value, "active"); }
      else if (index === 2) { assert.equal(result.status, "fulfilled"); if (result.status === "fulfilled") assert.equal(result.value, false); }
      else assert.ok(result.status === "rejected" && result.reason instanceof cleanup.SandboxCleanupBlockedError);
    }
    assert.deepEqual(await snapshot(), before!);
  }
  assert.equal(artifacts.size, 2);
  assert.equal(external, 0);
  console.log("PASS: guarded PostgreSQL DELETE/POST terminal races, explicit 409 with incomplete World evidence, callback/no-op bypass blocked, rollback and all private references/artifacts retained; zero Blob/Sandbox/provider/workflow effects.");
} finally {
  // Only synthetic rows owned by this fixture; never weaken application cleanup.
  await sql.query("DELETE FROM cases WHERE id=$1", [id]);
  await sql.query("DELETE FROM admin_notifications WHERE case_id=$1", [id]);
  await sql.end();
  mock.restoreAll();
  setWorld(undefined);
}
