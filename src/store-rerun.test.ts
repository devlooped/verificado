import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { failResolvedCase, requeueCase, restartCase } from "./store.ts";
import { setWorld } from "workflow/runtime";

type Call = { sql: string; args?: unknown[] };
function fakeDatabase(t: TestContext, status: string | undefined, missingImage = false) {
  setWorld({ specVersion: 8, runs: { get: async (runId: string) => ({ runId, status: "completed", deploymentId: "fixture-deployment" }) },
    steps: { list: async () => ({ data: [{ runId: "run-1", status: "completed" }], hasMore: false, cursor: null }) } } as unknown as Parameters<typeof setWorld>[0]);
  t.after(() => setWorld(undefined));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: Call[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.startsWith("SELECT status")) return { rows: status ? [{ status, workflow_run_id: "run-1" }] : [] };
      if (sql.startsWith("SELECT submission")) return { rows: [{ missing_image: missingImage }] };
      if (sql.startsWith("SELECT old_id")) return { rows: [{ old_id: "old-id" }] };
      return { rows: [], rowCount: 1 };
    },
    release: () => { calls.push({ sql: "release" }); },
  })) as unknown as typeof Pool.prototype.connect);
  return calls;
}

test("restart archives private references before reset, keeping the ID and original upload", async (t) => {
  const calls = fakeDatabase(t, "resolved");
  const blobs: string[][] = [];
  assert.equal(await restartCase("AA-123-BB", async (ids) => {
    assert.ok(calls.some(({ sql }) => sql.startsWith("INSERT INTO case_rerun_resources")));
    assert.ok(!calls.some(({ sql }) => sql.startsWith("DELETE")));
    blobs.push(ids);
  }), "queued");
  assert.deepEqual(blobs, [["AA-123-BB", "old-id"]]);
  const archive = calls.find(({ sql }) => sql.startsWith("INSERT INTO case_rerun_resources"))!;
  for (const table of ["case_aliases", "case_phase_sessions", "case_sandbox_bindings", "case_source_operations", "case_source_aliases", "case_audit_records"]) assert.ok(archive.sql.includes(table));
  assert.equal(archive.args?.[0], "AA-123-BB");
  assert.ok(!calls.some(({ sql }) => sql.startsWith("DELETE FROM images") || sql.startsWith("DELETE FROM case_rerun_resources")));
  assert.ok(calls.some(({ sql }) => sql.includes("status = 'queued'") && sql.includes("workflow_run_id = NULL")));
  const reset = calls.find(({ sql }) => sql.startsWith("UPDATE cases SET status = 'queued'"))!;
  assert.doesNotMatch(reset.sql, /created_at/);
  assert.deepEqual(reset.args, ["AA-123-BB"]);
  assert.ok(calls.some(({ sql }) => sql === "COMMIT"));
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

test("legacy requeue also retains private references before a fresh run", async (t) => {
  const calls = fakeDatabase(t, "failed");
  const blobs: string[][] = [];
  assert.equal(await requeueCase("AA-123-BB", async (ids) => { blobs.push(ids); }), true);
  assert.deepEqual(blobs, [["AA-123-BB", "old-id"]]);
  assert.ok(calls.some(({ sql }) => sql.startsWith("INSERT INTO case_rerun_resources")));
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

test("a Blob failure rolls back the reset without losing private references", async (t) => {
  const calls = fakeDatabase(t, "failed");
  await assert.rejects(restartCase("AA-123-BB", async () => { throw new Error("Blob failure"); }), /Blob failure/);
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
