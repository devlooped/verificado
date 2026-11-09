import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { context, trace } from "@opentelemetry/api";
import { caseArtifactStore } from "../evidence/blob.ts";
import { courtSession, linkEvidenceRun } from "./court-session.ts";
import type { TurnOutcome } from "../court/turns.ts";
import { COUNSEL_MODELS, DEFAULT_MODELS, MOCK_MODEL_ID, MODEL_ROLES, modelSnapshot } from "../court/models.ts";

test("shared failure cleanup retains all sandboxes without masking the primary failure or starting external calls", async t => {
  const keys = ["DATABASE_URL", "COURT_AI_MODE", "COURT_PIPELINE_VERSION"] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); });
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  process.env.COURT_AI_MODE = "live";
  delete process.env.COURT_PIPELINE_VERSION;
  const row = { id: "shared-missing-image", status: "queued", created_at: "2026-11-07T00:00:00Z", continuation_generation: 0, pipeline_version: 2, submission: { kind: "image", mimeType: "image/png" }, models: modelSnapshot(DEFAULT_MODELS) };
  let external = 0, revocations = 0;
  const primary = new Error("fixture primary collection failure");
  t.mock.method(caseArtifactStore, "write", async () => { throw primary; });
  t.mock.method(globalThis, "fetch", async () => { external++; throw new Error("forbidden network"); });
  t.mock.method(Sandbox, "get", (async () => { external++; throw new Error("forbidden sandbox"); }) as typeof Sandbox.get);
  t.mock.method(Sandbox, "list", (async () => { external++; throw new Error("forbidden list"); }) as typeof Sandbox.list);
  t.mock.method(Pool.prototype, "query", (async (query: string) => ({ rows: query.startsWith("SELECT * FROM cases") ? [row] : [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({ query: async (query: string) => {
    if (query.startsWith("SELECT id, continuation_generation")) return { rows: [row] };
    if (query.startsWith("SELECT id, submission FROM cases WHERE")) return { rows: [] };
    if (query.startsWith("UPDATE cases SET status = 'in_session'")) { row.status = "in_session"; return { rows: [row] }; }
    if (query.startsWith("UPDATE case_sandbox_bindings")) revocations++;
    if (query.startsWith("WITH updated AS (UPDATE cases SET status = 'failed'")) row.status = "failed";
    return { rows: [] };
  }, release: () => {} })) as unknown as typeof Pool.prototype.connect);
  await assert.rejects(courtSession(row.id), error => error === primary);
  assert.equal(row.status, "failed");
  assert.equal(revocations, 1, "revoking grants preserves sandbox identities; it does not authorize deletion");
  assert.equal(external, 0);

  // A cleanup step wrapper itself can reject before running its body. Keep
  // that secondary failure from replacing the original workflow exception.
  const marker = trace.getTracer("fixture").startSpan("fixture.cleanup");
  t.mock.method(trace, "getTracer", () => ({ startSpan: (name: string) => name === "case.dispose_sandboxes" ? marker : undefined }) as unknown as ReturnType<typeof trace.getTracer>);
  t.mock.method(context, "with", () => { throw new Error("fixture cleanup step wrapper failure"); });
  row.status = "queued";
  await assert.rejects(courtSession(row.id), error => error === primary);
  assert.equal(row.status, "failed");
  assert.equal(revocations, 2);
  assert.equal(external, 0);
});

test("links only statements to the promoted evidence run for their own attempt", () => {
  const outcome: TurnOutcome = { done: false, events: [
    { type: "statement", id: "I1", by: "grok", stage: "closing", text: "Argumento", evidenceIds: [], at: "2026-01-01T00:00:00.000Z" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "Motivo", at: "2026-01-01T00:00:01.000Z" },
  ] };
  assert.deepEqual(linkEvidenceRun(outcome).events[0], { ...outcome.events[0], modelId: COUNSEL_MODELS.grok.id, effort: "high" });
  const linked = linkEvidenceRun(outcome, "run-1");
  assert.deepEqual(linked.events[0], { ...outcome.events[0], evidenceRunId: "run-1", modelId: COUNSEL_MODELS.grok.id, effort: "high" });
  assert.deepEqual(linkEvidenceRun(outcome, undefined, true).events[0], { ...outcome.events[0], modelId: MOCK_MODEL_ID, effort: null });
  assert.deepEqual(linked.events[1], outcome.events[1]);
  assert.notEqual(linked.events[0], outcome.events[0]);
});

test("a collection failure after opening marks the case as failed and rethrows", async (t) => {
  const env = ["DATABASE_URL", "COURT_AI_MODE", "COURT_PIPELINE_VERSION", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const originalEnv = env.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  process.env.COURT_AI_MODE = "live";
  // A recorded legacy case must resume without the new-case bridge preflight.
  delete process.env.COURT_PIPELINE_VERSION;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;

  const caseId = "missing-image";
  const row = {
    id: caseId,
    created_at: "2026-11-03T00:00:00.000Z",
    status: "queued",
    pipeline_version: 1,
    submission: { kind: "image", mimeType: "image/png" },
    owner_id: null,
    error: null as string | null,
    models: null as Record<string, { id: string; effort: string | null }> | null,
  };
  const closingUpdates: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("SELECT id, continuation_generation")) return {rows:[row]};
      if (sql.startsWith("UPDATE cases SET models") || sql.startsWith("WITH updated AS")) return Pool.prototype.query(sql,values);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql === "DELETE FROM events WHERE case_id = $1") return { rows: [] };
      if (sql.startsWith("SELECT id, submission FROM cases WHERE")) {
        assert.deepEqual(values, [caseId]);
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE cases SET status = 'in_session'")) {
        assert.deepEqual(values, [caseId]);
        row.status = "in_session";
        return { rows: [row] };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    },
    release: () => {},
  };
  t.mock.method(Pool.prototype, "connect", (async () => client) as unknown as typeof Pool.prototype.connect);
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events") || sql.startsWith("SELECT role, model_id, effort FROM model_settings")) return { rows: [] };
    if (sql.startsWith("SELECT * FROM cases WHERE")) return { rows: [row] };
    if (sql.startsWith("SELECT mime_type, bytes FROM images")) {
      assert.deepEqual(values, [caseId]);
      assert.equal(row.status, "in_session");
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE cases SET models = $2")) {
      assert.equal(values![0], caseId);
      row.models = JSON.parse(values![1] as string);
      return { rows: [] };
    }
    if (sql.startsWith("WITH updated AS (UPDATE cases SET status = 'failed'")) {
      closingUpdates.push(values!);
      row.status = "failed";
      row.error = values![1] as string;
      return { rows: [] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }) as typeof Pool.prototype.query);
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url) === "https://models.dev/api.json") return Response.json({ vercel: { models: Object.fromEntries(MODEL_ROLES.map((role) => [role.defaultId, { modalities: { output: [role.kind === "image" ? "image" : "text"] } }])) } });
    if (String(url) === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });
    throw new Error("Unexpected network access");
  });

  const message = `No se encontró la imagen original del caso ${caseId}.`;
  await assert.rejects(courtSession(caseId), { message });
  assert.equal(closingUpdates.length, 1);
  assert.equal(closingUpdates[0]![0], caseId);
  assert.equal(closingUpdates[0]![1], message);
  assert.match(closingUpdates[0]![3] as string, /registros de Vercel/);
  assert.equal(row.status, "failed");
  assert.equal(row.error, message);
  assert.deepEqual(row.models?.judge, { id: "spacexai/grok-4.7", effort: "high" }, "the case keeps the models configured when it opened");
  // Re-entry must retain the concrete snapshot, even if a newer catalog exists.
  row.status = "queued";
  row.models!.judge = { id: "spacexai/grok-4.3", effort: "high" };
  await assert.rejects(courtSession(caseId), { message });
  assert.equal(row.models?.judge?.id, "spacexai/grok-4.3");
});

test("a bridge preflight failure before opening marks the case failed and creates an alert", async (t) => {
  const keys = ["DATABASE_URL", "COURT_AI_MODE", "COURT_PIPELINE_VERSION", "VERCEL_OIDC_TOKEN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "EVIDENCE_SANDBOX_SNAPSHOT_ID"] as const;
  const original = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) delete process.env[key];
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  process.env.COURT_AI_MODE = "live";
  process.env.COURT_PIPELINE_VERSION = "2";
  const queries: string[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("SELECT id, continuation_generation")) return {rows:[{id:"fixture",continuation_generation:0}]};
      if (sql.startsWith("WITH updated AS")) return Pool.prototype.query(sql,values);
      if (sql.startsWith("SELECT id, submission FROM cases WHERE")) return { rows: [{ id: "case-preflight", submission: { kind: "text", text: "fixture", check: "expert" } }] };
      throw new Error("Unexpected query");
    },
    release: () => {},
  };
  let alert: unknown[] | undefined;
  t.mock.method(Pool.prototype, "connect", (async () => client) as unknown as typeof Pool.prototype.connect);
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events")) return { rows: [] };
    if (sql.startsWith("WITH updated AS (UPDATE cases SET status = 'failed'")) { alert = values; return { rows: [] }; }
    throw new Error("Unexpected pool query");
  }) as typeof Pool.prototype.query);
  await assert.rejects(courtSession("case-preflight"), /Instruction sandbox bridge requires trusted/);
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(alert?.[0], "case-preflight");
  assert.match(alert?.[3] as string, /snapshot/);
  process.env.COURT_PIPELINE_VERSION = "1";
  alert = undefined;
  await assert.rejects(courtSession("case-rerun-preflight", true), /Instruction sandbox bridge requires trusted/, "a rerun uses the latest pipeline rather than the legacy rollback");
  assert.equal(alert?.[0], "case-rerun-preflight");
});
