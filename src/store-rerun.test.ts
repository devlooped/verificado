import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { failResolvedCase, requeueCase, restartCase } from "./store.ts";
import { SandboxCleanupBlockedError } from "./lib/sandbox-cleanup.ts";

type Call = { sql: string; args?: unknown[] };
function fakeDatabase(t: TestContext, status: string | undefined, missingImage = false) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: Call[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.startsWith("SELECT status")) return { rows: status ? [{ status }] : [] };
      if (sql.startsWith("SELECT submission")) return { rows: [{ missing_image: missingImage }] };
      if (sql.startsWith("SELECT old_id")) return { rows: [{ old_id: "old-id" }] };
      return { rows: [] };
    },
    release: () => { calls.push({ sql: "release" }); },
  })) as unknown as typeof Pool.prototype.connect);
  return calls;
}

test("restart preserves generated state and private references before any callback or reset", async (t) => {
  const calls = fakeDatabase(t, "resolved");
  const blobs: string[][] = [];
  await assert.rejects(restartCase("AA-123-BB", async (ids) => { blobs.push(ids); }), SandboxCleanupBlockedError);
  assert.deepEqual(blobs, []);
  assert.deepEqual(calls.map(({ sql }) => sql), [
    "BEGIN",
    "SELECT status, stopped_workflow_run_id, continuation_generation FROM cases WHERE id = $1 FOR UPDATE",
    "SELECT submission->>'kind' = 'image' AND NOT EXISTS (SELECT 1 FROM images WHERE case_id = $1) AS missing_image FROM cases WHERE id = $1",
    "ROLLBACK",
    "release",
  ]);
});

test("missing or active cases cannot be reset", async (t) => {
  for (const [status, result] of [[undefined, "missing"], ["queued", "active"], ["in_session", "active"]] as const) {
    await t.test(String(status), async (sub) => {
      const calls = fakeDatabase(sub, status);
      let deleted = false;
      assert.equal(await restartCase("AA-123-BB", async () => { deleted = true; }), result);
      assert.equal(deleted, false);
      assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
      assert.ok(!calls.some(({ sql }) => sql.startsWith("DELETE")));
    });
  }
});

test("legacy requeueCase cannot bypass the cleanup block with a no-op callback", async (t) => {
  const calls = fakeDatabase(t, "failed");
  const blobs: string[][] = [];
  await assert.rejects(requeueCase("AA-123-BB", async (ids) => { blobs.push(ids); }), SandboxCleanupBlockedError);
  assert.deepEqual(blobs, []);
  assert.ok(!calls.some(({ sql }) => /^(DELETE|UPDATE|COMMIT)/.test(sql)));
  assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
});

test("legacy requeueCase does not reset resolved, active or missing cases", async (t) => {
  for (const status of ["resolved", "queued", "in_session", undefined]) await t.test(String(status), async (sub) => {
    const calls = fakeDatabase(sub, status);
    let cleaned = false;
    assert.equal(await requeueCase("AA-123-BB", async () => { cleaned = true; }), false);
    assert.equal(cleaned, false);
    assert.ok(!calls.some(({ sql }) => /^(DELETE|UPDATE)/.test(sql)));
    assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
  });
});

test("a missing original image rejects the rerun before deleting case data or blobs", async (t) => {
  const calls = fakeDatabase(t, "resolved", true);
  let deleted = false;
  assert.equal(await restartCase("AA-123-BB", async () => { deleted = true; }), "missing-image");
  assert.equal(deleted, false);
  assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!calls.some(({ sql }) => sql.startsWith("DELETE") || sql.startsWith("UPDATE")));
});

test("cleanup safety failure rolls back before even invoking a failing Blob callback", async (t) => {
  const calls = fakeDatabase(t, "failed");
  await assert.rejects(restartCase("AA-123-BB", async () => { throw new Error("must not reach Blob"); }), SandboxCleanupBlockedError);
  assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!calls.some(({ sql }) => sql.startsWith("DELETE") || sql.startsWith("UPDATE")));
});

test("marks only the same resolved revision as a failed run, with an admin notification", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: Call[] = [];
  let rowCount = 1;
  t.mock.method(Pool.prototype, "query", (async (sql: string, args?: unknown[]) => { calls.push({ sql, args }); return { rows: [], rowCount }; }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, args?: unknown[]) => sql.startsWith("SELECT id, continuation_generation") ? {rows:[{id:"AA-123-BB",continuation_generation:0}]} : Pool.prototype.query(sql,args),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  assert.equal(await failResolvedCase("AA-123-BB", 4, "missing files"), true);
  const update = calls.find(({ sql }) => sql.includes("UPDATE cases SET status = 'failed'"))!;
  assert.match(update.sql, /status = 'resolved' AND revision = \$2/);
  assert.match(update.sql, /INSERT INTO admin_notifications/);
  assert.deepEqual(update.args!.slice(0, 3), ["AA-123-BB", 4, "missing files"]);
  rowCount = 0;
  assert.equal(await failResolvedCase("AA-123-BB", 4, "missing files"), false);
});
