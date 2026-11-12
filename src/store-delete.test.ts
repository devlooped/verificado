import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { deleteCase, withCaseWriteLock } from "./store.ts";
import { SandboxCleanupBlockedError } from "./lib/sandbox-cleanup.ts";

function fakeDatabase(t: TestContext, status: string | undefined, sandboxFree = false) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT status")) return { rows: status ? [{ status, sandbox_free: sandboxFree }] : [] };
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
  assert.equal(calls.length, 4);
  assert.deepEqual([calls[0], calls[2], calls[3]], ["BEGIN", "ROLLBACK", "release"]);
  assert.ok(calls[1]!.startsWith("SELECT status") && calls[1]!.includes("FOR UPDATE"));
});

test("an Expert case or a Quick check with sandbox references stays behind the guard, even with the sandbox-free callback", async (t) => {
  const calls = fakeDatabase(t, "resolved", false);
  await assert.rejects(deleteCase("AA-123-BB", async () => { calls.push("guarded"); }, async () => { calls.push("free"); }), SandboxCleanupBlockedError);
  assert.ok(!calls.includes("guarded") && !calls.includes("free"));
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
});

test("a sandbox-free Quick check is deleted without the sandbox guard, with its aliases", async (t) => {
  const calls = fakeDatabase(t, "resolved", true);
  let removed: string[] = [];
  assert.equal(await deleteCase("AA-123-BB", async () => { throw new Error("must not use the guarded path"); }, async (ids) => { removed = ids; }), "deleted");
  assert.deepEqual(removed, ["AA-123-BB", "old-id"]);
  assert.ok(calls.includes("DELETE FROM cases WHERE id = $1"));
  assert.ok(calls.includes("COMMIT"));
});

test("a sandbox-free Quick check still goes through the guard when no sandbox-free callback is given", async (t) => {
  const calls = fakeDatabase(t, "failed", true);
  await assert.rejects(deleteCase("AA-123-BB", async () => { calls.push("blob"); }), SandboxCleanupBlockedError);
  assert.ok(!calls.includes("blob"));
});

test("a sandbox-free Quick check that is still running is not deleted", async (t) => {
  const calls = fakeDatabase(t, "in_session", true);
  assert.equal(await deleteCase("AA-123-BB", async () => {}, async () => { throw new Error("unexpected"); }), "active");
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
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
