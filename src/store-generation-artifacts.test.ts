import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { Script } from "node:vm";
import { Pool } from "pg";
import { publishGenerationArtifactReference } from "./store.ts";
import { continuationJson, CONTINUATION_ENABLED } from "./domain/continuation.ts";
import { stageGenerationArtifact, type GenerationArtifactReference, type GenerationObjectStore, type StagedGenerationArtifact } from "./evidence/generation-artifacts.ts";
import { sha256 } from "./evidence/validate.ts";

// Existing source-inspection tooling uses this bundled parser; TS 7 has no JS
// compiler API. Type erasure is Node-local, with no new dependency or subprocess.
type Statement = { type: string; start: number; end: number; id?: { name: string } };
const parser = createRequire(import.meta.url)("next/dist/compiled/babel/parser.js") as {
  parse(source: string, options: object): { program: { body: Statement[] } };
};
const parse = (source: string) => parser.parse(source, { sourceType: "module", plugins: ["typescript"] }).program.body;

// TEST ONLY, not exported. Copies three private transaction primitives into a VM
// with ONLY an in-memory db double and JSON canonicalizer. No Pool/import/require,
// store hook, env bypass, or alternate runtime publication entry point exists.
function isolatedArtifactProtocol(client: { query(sql: string, args?: unknown[]): Promise<unknown>; release(): void }) {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  const statements = parse(source);
  const names = ["assertCaseWriter", "withCaseMutation", "continuationAudit"];
  const functions = names.map((name) => {
    // An exported declaration would be wrapped in ExportNamedDeclaration and
    // fail this lookup: the model must use only private store primitives.
    const node = statements.find((s) => s.type === "FunctionDeclaration" && s.id?.name === name);
    assert.ok(node, `Missing private primitive: ${name}`);
    return source.slice(node.start, node.end);
  }).join("\n");
  const model = `${functions}\n(async (reference) => {
    const {caseId, generation, runId, path} = reference;
    await withCaseMutation(caseId, {generation, runId}, async (client) => {
      await continuationAudit(client, caseId, generation, 'artifact-reference/v1/' + path, reference);
    });
  })`;
  const js = stripTypeScriptTypes(model);
  const context = { db: async () => ({ connect: async () => client }), continuationJson };
  assert.equal(new Script("typeof process + ':' + typeof require + ':' + typeof fetch").runInNewContext(context), "undefined:undefined:undefined");
  return new Script(js).runInNewContext(context) as (reference: GenerationArtifactReference) => Promise<void>;
}

test("productive publication rejects genuine Map receipts before DB, regardless of environment flags", async (t) => {
  const names = ["DATABASE_URL", "CONTINUATION_ENABLED"] as const;
  const before = names.map((name) => process.env[name]);
  t.after(() => { names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }); });
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  let dbCalls = 0, externalCalls = 0;
  t.mock.method(Pool.prototype, "query", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", async () => { externalCalls++; throw new Error("External call forbidden"); });
  const objects = new Map<string, Uint8Array>();
  const transport: GenerationObjectStore = {
    async createOnly(key, bytes) { objects.set(key, new Uint8Array(bytes)); }, async read(key) { return objects.get(key); },
  };
  const receipt = await stageGenerationArtifact(transport, "fixture", { generation: 1, runId: "run" }, "quick/result.json", "original", sha256("original"));
  assert.equal(CONTINUATION_ENABLED, false);
  for (const flag of [undefined, "false", "true", "1"]) {
    if (flag === undefined) delete process.env.CONTINUATION_ENABLED; else process.env.CONTINUATION_ENABLED = flag;
    for (const candidate of [receipt, { ...receipt } as StagedGenerationArtifact, undefined as unknown as StagedGenerationArtifact]) {
      await assert.rejects(publishGenerationArtifactReference(candidate), (e: unknown) => (e as { reason: string }).reason === "generation_artifact_retention_unproved");
    }
  }
  const hostile = new Proxy(receipt, { get() { throw new Error("Receipt must not be inspected"); } });
  await assert.rejects(publishGenerationArtifactReference(hostile), /retention_unproved/);
  assert.equal(dbCalls, 0); assert.equal(externalCalls, 0);
});

test("test-only protocol composition has no runtime import, export or environment seam", () => {
  const statements = parse(readFileSync(new URL("./store-generation-artifacts.test.ts", import.meta.url), "utf8"));
  assert.equal(statements.some((s) => s.type.startsWith("Export")), false);
  function inspect(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory()) { inspect(new URL(`${entry.name}/`, directory)); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const source = readFileSync(url, "utf8");
      assert.equal(source.includes("isolatedArtifactProtocol"), false, url.pathname);
      assert.equal(source.includes("store-generation-artifacts.test"), false, url.pathname);
      assert.equal(source.includes("test-local-generation-artifacts"), false, url.pathname);
    }
  }
  inspect(new URL("./", import.meta.url));
});

test("test-only VM protocol models immutable reconciled fencing and lost COMMIT, without production publication", async () => {
  let row = { id: "fixture", continuation_generation: 1, workflow_run_id: "run", status: "in_session", stopped_workflow_run_id: null as string | null };
  let generation = { state: "running", run_id: "run", reconciled_run_id: "run" };
  const originalRow = { ...row }, originalGeneration = { ...generation };
  let committed = new Map<string, string>(), pending = new Map<string, string>();
  let loseCommit = false, failInsert = false, releases = 0;
  const calls: string[] = [];
  const protocolOnlyPublication = isolatedArtifactProtocol({
    async query(sql: string, args: unknown[] = []) {
      calls.push(sql);
      if (sql === "BEGIN") pending = new Map(committed);
      if (sql.startsWith("SELECT id, continuation_generation")) return { rows: row.id ? [row] : [] };
      if (sql.startsWith("SELECT state, run_id, reconciled_run_id")) return { rows: [generation] };
      if (sql.startsWith("INSERT INTO case_continuation_audit")) {
        if (failInsert) throw new Error("DB insert failed");
        const key = JSON.stringify(args.slice(0, 3)), value = String(args[3]);
        if (pending.has(key) && pending.get(key) !== value) return { rowCount: 0 };
        pending.set(key, value); return { rowCount: 1 };
      }
      if (sql === "COMMIT") { committed = new Map(pending); if (loseCommit) { loseCommit = false; throw new Error("COMMIT response lost"); } }
      if (sql === "ROLLBACK") pending = new Map(committed);
      return { rows: [] };
    },
    release() { releases++; },
  });
  const objects = new Map<string, Uint8Array>();
  const transport: GenerationObjectStore = {
    async createOnly(key, bytes) { if (objects.has(key)) throw new Error("412"); objects.set(key, new Uint8Array(bytes)); },
    async read(key) { return objects.get(key); },
  };
  const stage = (content = "original", caseId = "fixture", gen = 1, runId = "run") => stageGenerationArtifact(transport, caseId, { generation: gen, runId }, "quick/result.json", content, sha256(content));
  const receipt = await stage();
  assert.equal(calls.length, 0);
  await protocolOnlyPublication(receipt);
  assert.equal(committed.size, 1);
  assert.deepEqual(calls.slice(0, 3).map((sql) => sql.split(" ")[0]), ["BEGIN", "SELECT", "SELECT"]);
  assert.ok(calls[1]!.endsWith("FOR UPDATE"));
  assert.ok(calls[3]!.includes("WHERE case_continuation_audit.body=EXCLUDED.body"));
  assert.equal(calls.at(-1), "COMMIT");
  const before = new Map(committed);
  await protocolOnlyPublication(await stage());
  assert.deepEqual(committed, before);
  await assert.rejects(protocolOnlyPublication(await stage("different")), /audit collision/);
  assert.equal(calls.at(-1), "ROLLBACK"); assert.deepEqual(committed, before);
  assert.equal(objects.size, 2); // Conflicting logical reference leaves an orphan, not a deletion.

  for (const changed of [
    { continuation_generation: 2 }, { workflow_run_id: "other" }, { status: "failed" }, { stopped_workflow_run_id: "run" }, { id: "" },
  ]) {
    row = { ...originalRow, ...changed }; calls.length = 0;
    await assert.rejects(protocolOnlyPublication(receipt), /fenced|ya no existe/);
    assert.equal(calls.some((sql) => sql.startsWith("INSERT")), false);
    assert.equal(calls.at(-1), "ROLLBACK"); assert.deepEqual(committed, before);
  }
  row = { ...originalRow };
  for (const changed of [{ state: "blocked" }, { state: "uncertain" }, { state: "starting" }, { state: "finished" }, { run_id: "other" }, { reconciled_run_id: "" }]) {
    generation = { ...originalGeneration, ...changed }; calls.length = 0;
    await assert.rejects(protocolOnlyPublication(receipt), /start not reconciled/);
    assert.equal(calls.some((sql) => sql.startsWith("INSERT")), false);
    assert.deepEqual(committed, before);
  }
  generation = { ...originalGeneration };
  failInsert = true;
  await assert.rejects(protocolOnlyPublication(receipt), /DB insert failed/);
  assert.equal(calls.at(-1), "ROLLBACK"); failInsert = false;
  assert.deepEqual(committed, before);
  // A committed transaction with a lost response is retried only after staging.
  const second = await stage("second", "fixture", 2, "run-two");
  row = { ...originalRow, continuation_generation: 2, workflow_run_id: "run-two" };
  generation = { state: "running", run_id: "run-two", reconciled_run_id: "run-two" };
  loseCommit = true;
  await assert.rejects(protocolOnlyPublication(second), /COMMIT response lost/);
  const afterCommit = new Map(committed);
  await protocolOnlyPublication(await stage("second", "fixture", 2, "run-two"));
  assert.deepEqual(committed, afterCommit); assert.equal(committed.size, 2);
  await assert.rejects(protocolOnlyPublication(receipt), /fenced/);
  assert.ok(releases > 0);

  // Cancellation/generation change during upload: late immutable object survives,
  // but the reference cannot be published, even if readback completed successfully.
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const slow: GenerationObjectStore = {
    async createOnly(key, bytes) { await transport.createOnly(key, bytes); entered.resolve(); await release.promise; }, read: transport.read,
  };
  const late = stageGenerationArtifact(slow, "fixture", { generation: 2, runId: "run-two" }, "quick/late.json", "late", sha256("late"));
  await entered.promise; row.status = "failed"; release.resolve();
  const lateReceipt = await late;
  await assert.rejects(protocolOnlyPublication(lateReceipt), /fenced/);
  assert.ok(objects.has(lateReceipt.key)); assert.deepEqual(committed, afterCommit);
  assert.equal(calls.some((sql) => /DELETE|UPDATE cases|checkpoint|events/.test(sql)), false);
});
