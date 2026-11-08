import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { savePhaseCheckpoint, saveSandboxBinding } from "./store.ts";
import type { SandboxBinding } from "./instruction/authorization.ts";

const binding: SandboxBinding = { phase: "instruction", seat: "grok", sessionKey: "instruction:grok:preparation", phaseSessionId: "phase-1", expiresAt: "2000-01-01T00:00:00Z", revoked: false, model: { id: "fixture/model" }, gatewayTools: [] };

function database(t: TestContext, status: string, generation = 0) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const queries: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({ query: async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith("SELECT id, continuation_generation")) return { rows: [{ id: "fixture", status, continuation_generation: generation, workflow_run_id: "fixture-run" }] };
    if (sql === "SELECT status FROM cases WHERE id = $1") return { rows: [{ status }] };
    return { rows: [], rowCount: 1 };
  }, release: () => { queries.push("release"); } })) as unknown as typeof Pool.prototype.connect);
  return queries;
}

test("terminal or nonexecuting legacy resource writers cannot replace retained checkpoints or bindings", async t => {
  for (const status of ["failed", "resolved", "queued", "missing-evidence"]) await t.test(status, async sub => {
    const queries = database(sub, status);
    await assert.rejects(savePhaseCheckpoint("fixture", binding.sessionKey, 0, { sandboxId: "replacement" }), /writer blocked/);
    await assert.rejects(saveSandboxBinding("fixture", "sandbox", binding), /writer blocked/);
    assert.ok(!queries.some(sql => /^(INSERT|UPDATE)/.test(sql)));
    assert.equal(queries.filter(sql => sql === "ROLLBACK").length, 2);
  });
});

test("executing legacy writers keep CAS and immutable sandbox/session ownership guards under the case lock", async t => {
  const queries = database(t, "in_session");
  assert.equal(await savePhaseCheckpoint("fixture", binding.sessionKey, 0, { id: "phase-1", sandboxId: "sandbox" }), 1);
  await saveSandboxBinding("fixture", "sandbox", binding);
  const phase = queries.find(sql => sql.startsWith("UPDATE case_phase_sessions"))!;
  assert.ok(phase.includes("revision = $3"));
  assert.ok(phase.includes("body->>'sandboxId' = $4::jsonb->>'sandboxId'"));
  assert.ok(phase.includes("body->>'id' = $4::jsonb->>'id'"));
  const grant = queries.find(sql => sql.startsWith("INSERT INTO case_sandbox_bindings"))!;
  assert.ok(grant.includes("body->>'sessionKey' = EXCLUDED.body->>'sessionKey'"));
  assert.ok(grant.includes("COALESCE(case_sandbox_bindings.body->'writer'"));
  assert.ok(queries.indexOf(phase) > queries.findIndex(sql => sql.endsWith("FOR UPDATE")));
  assert.equal(queries.filter(sql => sql === "COMMIT").length, 2);
});

test("expired grants and legacy credentials cannot bypass a reserved generation", async t => {
  const queries = database(t, "failed", 1);
  await assert.rejects(savePhaseCheckpoint("fixture", binding.sessionKey, 0, {}), /fenced/);
  await assert.rejects(saveSandboxBinding("fixture", "sandbox", binding), /fenced/);
  assert.ok(!queries.some(sql => /^(INSERT|UPDATE)/.test(sql)));
  assert.equal(queries.filter(sql => sql === "ROLLBACK").length, 2);
});
