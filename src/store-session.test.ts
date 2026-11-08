import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { openSession } from "./store.ts";

test("opening a new case awaits pipeline preflight and never reruns it for an existing case", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  let fresh = true, selected = 1, preflights = 0;
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT id, continuation_generation")) return { rows: [{id:"fixture",continuation_generation:0}] };
      if (sql.startsWith("SELECT id, submission FROM cases WHERE")) return { rows: fresh ? [{ id: "fixture", submission: { kind: "text", text: "fixture" } }] : [] };
      const chosen = /^UPDATE cases SET pipeline_version = (\d)/.exec(sql);
      if (chosen) { selected = Number(chosen[1]); return { rows: [] }; }
      if (sql.startsWith("UPDATE cases SET status = 'in_session'")) return { rows: [{ id: "fixture", created_at: "2026-01-01", status: "in_session", submission: { kind: "text", text: "fixture" }, owner_id: null, error: null, revision: 0, models: null, pipeline_version: selected }] };
      return { rows: [] };
    },
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const preflight = async () => { preflights++; await Promise.resolve(); return 2 as const; };
  assert.equal((await openSession("fixture", preflight)).pipelineVersion, 2);
  assert.equal(preflights, 1);
  assert.ok(calls.some((sql) => sql.startsWith("UPDATE cases SET pipeline_version = 2")));
  fresh = false;
  calls.length = 0;
  assert.equal((await openSession("fixture", preflight)).pipelineVersion, 2);
  assert.equal(preflights, 1);
  assert.ok(!calls.some((sql) => sql.startsWith("UPDATE cases SET pipeline_version = 2")));

  // Pipeline 3 is selected the same way and, being shared, keeps its events.
  fresh = true;
  selected = 1;
  calls.length = 0;
  assert.equal((await openSession("fixture", () => 3)).pipelineVersion, 3);
  assert.ok(calls.some((sql) => sql.startsWith("UPDATE cases SET pipeline_version = 3")));
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE FROM events")));
  fresh = true;
  selected = 1;
  calls.length = 0;
  assert.equal((await openSession("fixture", () => 4)).pipelineVersion, 4);
  assert.ok(calls.some((sql) => sql.startsWith("UPDATE cases SET pipeline_version = 4")));
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE FROM events")));
  fresh = true;
  selected = 1;
  calls.length = 0;
  assert.equal((await openSession("fixture", () => 5)).pipelineVersion, 5);
  assert.ok(calls.some((sql) => sql.startsWith("UPDATE cases SET pipeline_version = 5")));
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE FROM events")));
});
