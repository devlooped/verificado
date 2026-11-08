import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { SANDBOX_CLEANUP_BLOCKED_RESPONSE } from "../lib/sandbox-cleanup.ts";
import { auth0 } from "../lib/auth0.ts";
import { POST } from "./api/cases/[id]/rerun/route.ts";

test("POST independently checks the server session before accessing storage", async (t) => {
  const db = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const req = new Request("https://example.test/api/cases/AA-123-BB/rerun", { method: "POST", headers: { origin: "https://example.test" } });
  for (const [user, expected] of [[undefined, 401], [{ sub: "user", roles: ["beta"] }, 403], [{ sub: "user", roles: ["admin"] }, 403], [{ roles: ["Admin"] }, 401]] as const) {
    const mocked = t.mock.method(auth0, "getSession", async () => user ? ({ user } as unknown as Awaited<ReturnType<typeof auth0.getSession>>) : null);
    const response = await POST(req, { params: Promise.resolve({ id: "AA-123-BB" }) });
    assert.equal(response.status, expected);
    mocked.mock.restore();
  }
  assert.equal(db.mock.callCount(), 0);
});

test("authorized POST rerun returns cleanup_blocked without Blob/reset/start/finish effects", async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "user", roles: ["Admin"] } } as unknown as Awaited<ReturnType<typeof auth0.getSession>>));
  const queries: string[] = [];
  t.mock.method(Pool.prototype, "query", (async (sql: string) => {
    assert.ok(sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events"), sql);
    return { rows: [] };
  }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT status")) return { rows: [{ status: "resolved", continuation_generation: 0, retry_contract_version: null, stopped_workflow_run_id: "historical-run" }] };
      if (sql.startsWith("SELECT submission")) return { rows: [{ missing_image: false }] };
      assert.ok(["BEGIN", "ROLLBACK"].includes(sql), `unexpected effect: ${sql}`);
      return { rows: [] };
    }, release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  let effects = 0;
  const forbidden = async () => { effects++; throw new Error("unexpected external effect"); };
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(Sandbox, "get", forbidden as typeof Sandbox.get);
  t.mock.method(Sandbox, "list", forbidden as typeof Sandbox.list);
  const response = await POST(new Request("https://example.test/api/cases/AA-123-BB/rerun", { method: "POST", headers: { origin: "https://example.test" } }), { params: Promise.resolve({ id: "AA-123-BB" }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), SANDBOX_CLEANUP_BLOCKED_RESPONSE);
  assert.deepEqual(queries, ["BEGIN", "SELECT status, stopped_workflow_run_id, continuation_generation, retry_contract_version FROM cases WHERE id = $1 FOR UPDATE", "SELECT submission->>'kind' = 'image' AND NOT EXISTS (SELECT 1 FROM images WHERE case_id = $1) AS missing_image FROM cases WHERE id = $1", "ROLLBACK"]);
  assert.equal(effects, 0);
});
