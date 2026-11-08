import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { deleteCase, withCaseWriteLock } from "./store.ts";
import { SandboxCleanupBlockedError } from "./lib/sandbox-cleanup.ts";

function fakeDatabase(t: TestContext, status: string | undefined) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT status")) return { rows: status ? [{ status }] : [] };
      if (sql.startsWith("SELECT old_id")) return { rows: [{ old_id: "old-id" }] };
      if (sql.startsWith("SELECT id")) return { rows: status ? [{ id: "AA-123-BB" }] : [] };
      return { rows: [] };
    },
    release: () => { calls.push("release"); },
  })) as unknown as typeof Pool.prototype.connect);
  return calls;
}

test("delete fails closed before aliases, Blob callbacks or cascading deletion, even with a no-op callback", async (t) => {
  const calls = fakeDatabase(t, "resolved");
  await assert.rejects(deleteCase("AA-123-BB", async () => { calls.push("blob"); }), SandboxCleanupBlockedError);
  assert.deepEqual(calls, ["BEGIN", "SELECT status, stopped_workflow_run_id, continuation_generation, retry_contract_version FROM cases WHERE id = $1 FOR UPDATE", "ROLLBACK", "release"]);
});

test("does not delete active or missing cases and rolls back if blob cleanup fails", async (t) => {
  for (const [status, expected] of [["queued", "active"], ["in_session", "active"], [undefined, "missing"]] as const) {
    await t.test(String(status), async (sub) => {
      const calls = fakeDatabase(sub, status);
      assert.equal(await deleteCase("AA-123-BB", async () => { throw new Error("unexpected"); }), expected);
      assert.ok(calls.includes("ROLLBACK"));
      assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
    });
  }
  await t.test("failed cleanup", async (sub) => {
    const calls = fakeDatabase(sub, "failed");
    await assert.rejects(deleteCase("AA-123-BB", async () => { throw new Error("must not reach storage"); }), SandboxCleanupBlockedError);
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
  });
});

test("writes hold the exclusive fencing lock and stop if the case has been deleted", async (t) => {
  await t.test("existing", async (sub) => {
    const calls = fakeDatabase(sub, "resolved");
    assert.equal(await withCaseWriteLock("AA-123-BB", async () => { calls.push("write"); return 42; }), 42);
    assert.deepEqual(calls, ["BEGIN", "SELECT id, continuation_generation, workflow_run_id, status, stopped_workflow_run_id, retry_contract_version FROM cases WHERE id = $1 FOR UPDATE", "write", "COMMIT", "release"]);
  });
  await t.test("deleted", async (sub) => {
    const calls = fakeDatabase(sub, undefined);
    await assert.rejects(withCaseWriteLock("AA-123-BB", async () => { throw new Error("must not write"); }), /ya no existe/);
    assert.ok(calls.includes("ROLLBACK"));
  });
});
