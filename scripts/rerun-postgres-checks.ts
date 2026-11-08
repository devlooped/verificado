// Invoked only after the disposable runner proves Docker/SQL identity and
// bootstraps a fresh schema. World evidence and generated-file deletion are
// simulated; SQL, locking, archive persistence and rollback are real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { setWorld } from "workflow/runtime";
import * as store from "../src/store.ts";
import { withLegacyRunScope } from "../src/lib/rerun-run.ts";

export async function runRerunPostgresChecks(sql: Pool, check: (name: string, body: () => Promise<void>) => Promise<void>): Promise<void> {
  let status = "completed";
  setWorld({ specVersion: 8,
    runs: { get: async (runId: string) => ({ runId, status, deploymentId: "synthetic-deployment" }) },
    steps: { list: async ({ runId }: { runId: string }) => ({ data: [{ runId, status: "completed" }], hasMore: false, cursor: null }) },
  } as unknown as Parameters<typeof setWorld>[0]);
  const tables = ["events", "images", "covers", "case_aliases", "case_phase_sessions", "case_sandbox_bindings", "case_source_operations", "case_source_aliases", "case_audit_records", "case_rerun_resources"];
  const snapshot = async (id: string) => {
    const result: Record<string, unknown> = { cases: (await sql.query("SELECT to_jsonb(c) AS body FROM cases c WHERE id=$1", [id])).rows };
    for (const table of tables) result[table] = (await sql.query(`SELECT to_jsonb(t) AS body FROM ${table} t WHERE case_id=$1 ORDER BY to_jsonb(t)::text`, [id])).rows;
    return result;
  };
  const fixture = async () => {
    const id = "fixture-rerun-" + randomUUID(), runId = "synthetic-run-" + randomUUID(), sandbox = id + "-sandbox";
    await store.createCase(id, { kind: "image", mimeType: "image/png", note: "Synthetic only", language: "es" }, Buffer.from("original synthetic image"), "synthetic-owner");
    await store.openSession(id, 2);
    await store.saveCaseLanguage(id, "es");
    await store.recordEvents(id, [{ type: "instruction_opened", seq: 1, at: new Date().toISOString() }]);
    await store.saveCover(id, { mimeType: "image/png", bytes: Buffer.from("generated cover"), generated: true });
    const claim = await store.sourceOperationRepository.claim(id, "synthetic-source", "acquisition", 30_000);
    assert.ok(claim.owned);
    await store.sourceOperationRepository.publish(id, "synthetic-source", claim.owner, { snapshotId: "synthetic-private-snapshot" });
    await store.sourceOperationRepository.alias(id, "https://example.test/synthetic", "synthetic-source");
    await store.saveCaseAuditRecord(id, "synthetic-audit", { commandId: "synthetic-command" });
    await sql.query("INSERT INTO case_phase_sessions (case_id,session_key,body) VALUES ($1,'synthetic-session',$2)", [id, JSON.stringify({ id: "synthetic-phase", sandboxId: sandbox, snapshotId: "synthetic-private-snapshot", commandId: "synthetic-command" })]);
    await sql.query("INSERT INTO case_sandbox_bindings (case_id,sandbox_id,body) VALUES ($1,$2,$3)", [id, sandbox, JSON.stringify({ sessionKey: "synthetic-session", phaseSessionId: "synthetic-phase", revoked: false })]);
    await sql.query("INSERT INTO case_aliases (old_id,case_id) VALUES ($1,$2)", [id + "-alias", id]);
    await sql.query("UPDATE cases SET status='resolved',workflow_run_id=$2 WHERE id=$1", [id, runId]);
    return { id, runId, sandbox };
  };
  try {
    await check("rerun PostgreSQL: unproved inactivity and unsafe deletion retain every row", async () => {
      const f = await fixture(), before = await snapshot(f.id);
      status = "running";
      let callbacks = 0;
      assert.equal(await store.restartCase(f.id, async () => { callbacks++; }), "active");
      await assert.rejects(store.deleteCase(f.id, async () => { callbacks++; }), /Sandbox cleanup blocked/);
      assert.equal(callbacks, 0);
      assert.deepEqual(await snapshot(f.id), before);
      status = "completed";
    });
    await check("rerun PostgreSQL: archive rollback precedes reset on callback failure", async () => {
      const f = await fixture(), before = await snapshot(f.id);
      await assert.rejects(store.restartCase(f.id, async () => { throw new Error("Synthetic deletion failure"); }), /Synthetic deletion failure/);
      assert.deepEqual(await snapshot(f.id), before);
    });
    await check("rerun PostgreSQL: one concurrent reset, full private archive, original upload and stale-writer fencing", async () => {
      const f = await fixture();
      const original = (await sql.query("SELECT to_jsonb(c) AS body FROM cases c WHERE id=$1", [f.id])).rows[0].body;
      const before = await snapshot(f.id);
      let callbacks = 0;
      const results = await Promise.all([0, 1, 2, 3].map(() => store.restartCase(f.id, async ids => {
        callbacks++;
        assert.deepEqual(ids, [f.id, f.id + "-alias"]);
        // The callback runs while the store holds the actual case row lock.
        await assert.rejects(sql.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT", [f.id]), error => (error as { code?: string }).code === "55P03");
      })));
      assert.equal(results.filter(result => result === "queued").length, 1);
      assert.equal(results.filter(result => result === "active").length, 3);
      assert.equal(callbacks, 1);
      const archives = (await sql.query("SELECT body FROM case_rerun_resources WHERE case_id=$1", [f.id])).rows;
      assert.equal(archives.length, 1);
      const archive = archives[0].body;
      assert.deepEqual(archive.case, original);
      for (const [key, table] of Object.entries({ aliases: "case_aliases", sessions: "case_phase_sessions", bindings: "case_sandbox_bindings", operations: "case_source_operations", sourceAliases: "case_source_aliases", audit: "case_audit_records" })) {
        assert.deepEqual(archive[key], (before[table] as Array<{ body: unknown }>).map(row => row.body));
      }
      const after = await snapshot(f.id);
      assert.deepEqual(after.images, before.images);
      assert.deepEqual(after.case_aliases, before.case_aliases);
      for (const table of ["events", "covers", "case_phase_sessions", "case_sandbox_bindings", "case_source_operations", "case_source_aliases", "case_audit_records"]) assert.deepEqual(after[table], []);
      const current = await store.getCase(f.id);
      assert.equal(current?.status, "queued");
      assert.equal(current?.ownerId, "synthetic-owner");
      assert.equal(((after.cases as Array<{ body: { workflow_run_id: string | null } }>)[0]).body.workflow_run_id, null);
      assert.equal(current?.submission.resolvedLanguage, undefined);
      await assert.rejects(store.consumeSandboxBinding(f.sandbox), /sandbox_forbidden/);
      let writes = 0;
      await assert.rejects(withLegacyRunScope(f.runId, () => store.withCaseWriteLock(f.id, async () => { writes++; })), /fenced/);
      await store.startCaseWorkflow(f.id, async () => ({ runId: "synthetic-new-run" }), async () => { throw new Error("Unexpected cancellation"); });
      await withLegacyRunScope("synthetic-new-run", () => store.openSession(f.id, 2));
      await assert.rejects(withLegacyRunScope(f.runId, () => store.saveCaseAuditRecord(f.id, "late", { late: true })), /fenced/);
      await withLegacyRunScope("synthetic-new-run", () => store.withCaseWriteLock(f.id, async () => { writes++; }));
      assert.equal(writes, 1);
      assert.equal((await sql.query("SELECT count(*)::int AS n FROM case_rerun_resources WHERE case_id=$1", [f.id])).rows[0].n, 1);
    });
  } finally { setWorld(undefined); }
}
