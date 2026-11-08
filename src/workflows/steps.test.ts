import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { contextStorage } from "../../node_modules/@workflow/core/dist/step/context-storage.js";
import type { RecordedEvent } from "../domain/court.ts";
import { closeContinuationCase, openCase, saveContinuationEvents, saveEvents } from "./steps.ts";

test("a fresh rerun opens on the latest pipeline and an opened run keeps its version", async (t) => {
  const keys = ["DATABASE_URL", "COURT_AI_MODE", "COURT_PIPELINE_VERSION"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.DATABASE_URL = "postgresql://grokeado:fixture@127.0.0.1:5432/grokeado_local_fixture";
  process.env.COURT_AI_MODE = "mock";
  process.env.COURT_PIPELINE_VERSION = "1";
  const submission = { kind: "text", text: "fixture", check: "expert" };
  let fresh = true, version = 1;
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      if (sql.startsWith("SELECT id, continuation_generation")) return { rows: [{id:"rerun",continuation_generation:0}] };
      if (sql.startsWith("SELECT id, submission FROM cases WHERE")) return { rows: fresh ? [{ id: "rerun", submission }] : [] };
      const selected = /^UPDATE cases SET pipeline_version = (\d)/.exec(sql);
      if (selected) version = Number(selected[1]);
      if (sql.startsWith("UPDATE cases SET status = 'in_session'")) return { rows: [{ id: "rerun", created_at: "2026-01-01", status: "in_session", submission, owner_id: null, error: null, revision: 1, models: null, pipeline_version: version }] };
      return { rows: [] };
    },
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  t.mock.method(console, "info", () => {});
  const opened = await openCase("rerun", true);
  assert.equal(opened.pipelineVersion, 5);
  assert.equal(opened.caseDate, "2026-01-01");
  fresh = false;
  version = 3;
  assert.equal((await openCase("rerun", true)).pipelineVersion, 3, "reopening does not upgrade an existing run");
});

test("persisted collection progress logs correlated counts without event bodies and is safe to retry", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const rows = new Map<number, string>();
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events")) return { rows: [] };
    assert.ok(sql.includes("ON CONFLICT (case_id, seq) DO NOTHING"));
    for (let i = 1; i < values!.length; i += 3) if (!rows.has(values![i] as number)) rows.set(values![i] as number, values![i + 2] as string);
    return { rows: [] };
  }) as typeof Pool.prototype.query);
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, values?: unknown[]) => {
      if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)) return {rows:[]};
      if (sql.startsWith("SELECT id, continuation_generation")) return {rows:[{id:"CASE-TEST",continuation_generation:0,workflow_run_id:"wrun_fixture",stopped_workflow_run_id:null}]};
      return Pool.prototype.query(sql,values);
    }, release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, (line: string) => { logs.push(JSON.parse(line)); });
  const at = "2026-11-07T00:00:00.000Z";
  const events: RecordedEvent[] = [
    { type: "evidence_proposed", by: "grok", proposal: { claimId: "A1", url: "https://private.example/?token=secret", quote: "PRIVATE_CASE_CONTENT", stance: "supports" }, seq: 1, at },
    { type: "source_collection_started", total: 4, batches: 1, seq: 2, at },
    { type: "source_batch_started", batch: 1, batches: 1, urls: ["https://private.example/?token=secret"], seq: 3, at },
    { type: "source_batch_completed", batch: 1, batches: 1, count: 4, completed: 4, total: 4, failed: 1, sources: [{ url: "https://private.example/?token=secret", failed: true }], seq: 4, at },
  ];
  const workflow = { workflowName: "courtSession", workflowRunId: "wrun_fixture", workflowStartedAt: new Date(), url: "", features: { encryption: false } };
  const step = { stepName: "saveEvents", stepId: "step_fixture", stepStartedAt: new Date(), attempt: 2 };
  await contextStorage.run({ workflowMetadata: workflow, stepMetadata: step, ops: [], preCompletionOps: [] }, async () => {
    await saveEvents("CASE-TEST", events);
    await saveEvents("CASE-TEST", events);
  });
  assert.equal(rows.size, 4);
  const started = logs.find((line) => line.event === "case.sources.collection_started")!;
  const completed = logs.filter((line) => line.event === "case.sources.batch_completed");
  assert.equal(started["sources.total"], 4);
  assert.equal(logs.find((line) => line.event === "case.sources.batch_started")?.["sources.count"], 1);
  assert.equal(completed.length, 2, "a retried save may repeat its operational log");
  assert.ok(completed.every((line) => line.severity === "WARN" && line["events.seq"] === 4 && line["sources.failed"] === 1));
  assert.ok(logs.every((line) => line["case.id"] === "CASE-TEST" && line["case.version"] === "wrun_fixture" && line["workflow.step.attempt"] === 2));
  assert.doesNotMatch(JSON.stringify(logs), /private.example|secret|PRIVATE_CASE_CONTENT/);
});

test("new generation steps reject a supplied owner from another executing run before DB access", async () => {
  const workflow = { workflowName: "fixture", workflowRunId: "wrun_current", workflowStartedAt: new Date(), url: "", features: { encryption: false } };
  const step = { stepName: "fixture", stepId: "step_fixture", stepStartedAt: new Date(), attempt: 1 };
  await contextStorage.run({workflowMetadata:workflow,stepMetadata:step,ops:[],preCompletionOps:[]},async()=>{
    const writer={generation:1,runId:"wrun_other"};
    await assert.rejects(saveContinuationEvents("fixture",writer,[]),/does not match executing run/);
    await assert.rejects(closeContinuationCase("fixture",writer,"failed"),/does not match executing run/);
    await assert.rejects(saveContinuationEvents("fixture",{generation:1,runId:"wrun_current"},[]),/atomic checkpoint and phase publication/);
  });
});
