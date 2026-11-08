import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { setWorld } from "workflow/runtime";
import { deleteCase, finishCase, restartCase, startCaseWorkflow, stopCaseWorkflow } from "./store.ts";

function fakeDatabase(t: TestContext, row?: { status: string; workflow_run_id: string | null; stopped_workflow_run_id?: string }, failUpdate = false) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT status")) return { rows: row ? [row] : [] };
      if (sql.startsWith("SELECT submission")) return { rows: [{ missing_image: false }] };
      if (sql.startsWith("SELECT old_id")) return { rows: [] };
      if (failUpdate && sql.startsWith("UPDATE cases")) throw new Error("database failed");
      return { rows: [] };
    },
    release: () => { calls.push("release"); },
  })) as unknown as typeof Pool.prototype.connect);
  return calls;
}

test("starting records the run while holding the case row lock", async (t) => {
  const calls = fakeDatabase(t, { status: "queued", workflow_run_id: null });
  await startCaseWorkflow("fixture", async () => { calls.push("start"); return { runId: "run-1" }; }, async () => { throw new Error("unexpected cancel"); });
  assert.deepEqual(calls, ["BEGIN", "SELECT status, workflow_run_id, continuation_generation, retry_contract_version FROM cases WHERE id = $1 FOR UPDATE", "start", "UPDATE cases SET workflow_run_id = $2 WHERE id = $1", "COMMIT", "release"]);
});

test("a start that cannot be recorded cancels its newly created run", async (t) => {
  const calls = fakeDatabase(t, { status: "queued", workflow_run_id: null }, true);
  await assert.rejects(startCaseWorkflow("fixture", async () => ({ runId: "run-1" }), async (id) => { calls.push("cancel " + id); }), /database failed/);
  assert.ok(calls.indexOf("ROLLBACK") < calls.indexOf("cancel run-1"));
});

test("only active cases with a known run can be stopped", async (t) => {
  for (const [row, result] of [[undefined, "missing"], [{ status: "failed", workflow_run_id: "old" }, "inactive"], [{ status: "queued", workflow_run_id: null }, "unavailable"], [{ status: "queued", workflow_run_id: "run-1" }, "stopped"], [{ status: "in_session", workflow_run_id: "run-1" }, "stopped"]] as const) {
    await t.test(result + String(row?.status), async (sub) => {
      const calls = fakeDatabase(sub, row);
      assert.equal(await stopCaseWorkflow("fixture", async (id) => { calls.push("cancel " + id); }), result);
      assert.equal(calls.includes("cancel run-1"), result === "stopped");
      assert.equal(calls.includes("COMMIT"), result === "stopped");
      assert.equal(calls.some((sql) => sql.startsWith("UPDATE cases")), result === "stopped");
    });
  }
});

test("a cancellation failure rolls back without changing case status", async (t) => {
  const calls = fakeDatabase(t, { status: "in_session", workflow_run_id: "run-1" });
  await assert.rejects(stopCaseWorkflow("fixture", async () => { throw new Error("offline"); }), /offline/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.some((sql) => sql.startsWith("UPDATE cases")));
});

test("settled or cancelled known steps do not authorize reset/deletion or workflow enumeration", async (t) => {
  const calls = fakeDatabase(t, { status: "failed", workflow_run_id: "run-1", stopped_workflow_run_id: "run-1" });
  let running = true;
  let lists = 0;
  setWorld({ specVersion: 8, steps: { list: async () => { lists++; return { data: [{ status: running ? "running" : "completed" }], hasMore: false, cursor: null }; } } } as unknown as Parameters<typeof setWorld>[0]);
  t.after(() => setWorld(undefined));
  let cleanups = 0;
  const cleanup = async () => { cleanups++; };
  await assert.rejects(restartCase("fixture", cleanup), /Sandbox cleanup blocked/);
  await assert.rejects(deleteCase("fixture", cleanup), /Sandbox cleanup blocked/);
  assert.equal(cleanups, 0);
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
  running = false;
  await assert.rejects(restartCase("fixture", cleanup), /Sandbox cleanup blocked/);
  await assert.rejects(deleteCase("fixture", cleanup), /Sandbox cleanup blocked/);
  assert.equal(cleanups, 0);
  assert.equal(lists, 0);
});

test("late workflow completion and failure cannot change a stopped case", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async (sql: string) => { calls.push(sql); return { rows: [] }; }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => sql.startsWith("SELECT id, continuation_generation") ? {rows:[{id:"fixture",continuation_generation:0}]} : Pool.prototype.query(sql),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  await finishCase("fixture", "resolved");
  await finishCase("fixture", "failed", "late error");
  for (const sql of calls.filter((query) => query.includes("UPDATE cases SET status"))) assert.match(sql, /stopped_workflow_run_id IS NULL/);
});
