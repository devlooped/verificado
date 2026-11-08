import assert from "node:assert/strict";
import test from "node:test";
import { stageGenerationArtifact, stagedGenerationReference, generationArtifactPreflight, type GenerationObjectStore, type StagedGenerationArtifact } from "./generation-artifacts.ts";
import { stageCaseGenerationArtifact, caseArtifactStore } from "./blob.ts";
import { getObject, putObject } from "./r2.ts";
import { startFakeR2 } from "./r2-fake.ts";
import { sha256 } from "./validate.ts";
import { MemoryArtifactStore } from "./artifacts.ts";

const writer = { generation: 1, runId: "fixture-run" };
const path = "quick/answer/result.json";
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const store: GenerationObjectStore = {
    async createOnly(key, bytes) { calls.push(`create:${key}`); if (objects.has(key)) throw new Error("412"); objects.set(key, new Uint8Array(bytes)); },
    async read(key) { calls.push(`read:${key}`); const bytes = objects.get(key); return bytes && new Uint8Array(bytes); },
  };
  return { store, objects, calls };
}
const stage = (store: GenerationObjectStore, content = "original", caseId = "fixture", generation = 1) => stageGenerationArtifact(store, caseId, { ...writer, generation }, path, content, sha256(content));

test("staging is case/generation-isolated, immutable, idempotent and invisible to legacy artifacts", async () => {
  const f = fixture();
  const legacy = new MemoryArtifactStore();
  await legacy.write("fixture", new Map([[path, "legacy"]]));
  const first = await stage(f.store);
  assert.deepEqual(await stage(f.store), first);
  const otherCase = await stage(f.store, "original", "fixture-two");
  const otherGeneration = await stage(f.store, "original", "fixture", 2);
  assert.equal(new Set([first.key, otherCase.key, otherGeneration.key]).size, 3);
  assert.ok(first.key.startsWith("continuation-artifacts/v1/fixture/generations/1/"));
  assert.equal(first.sha256, sha256("original"));
  assert.equal(first.byteLength, 8);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(stagedGenerationReference(first), first);
  assert.throws(() => stagedGenerationReference({ ...first } as StagedGenerationArtifact), /verified staging receipt/);
  assert.throws(() => stagedGenerationReference(JSON.parse(JSON.stringify(first))), /verified staging receipt/);
  assert.equal(new TextDecoder().decode((await legacy.read("fixture")).get(path)), "legacy");
  assert.equal(f.objects.size, 3);
});

test("snapshots bytes, subarray offsets and writer before awaits, including transport mutation", async () => {
  const f = fixture();
  const input = new Uint8Array([0, 1, 2, 3]);
  const mutableWriter = { ...writer };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transport: GenerationObjectStore = {
    async createOnly(key, bytes) { await f.store.createOnly(key, bytes); bytes.fill(99); entered.resolve(); await release.promise; },
    read: f.store.read,
  };
  const result = stageGenerationArtifact(transport, "fixture", mutableWriter, path, input.subarray(1, 3), sha256(new Uint8Array([1, 2])));
  await entered.promise;
  input.fill(9); mutableWriter.generation = 2; mutableWriter.runId = "late";
  release.resolve();
  const receipt = await result;
  assert.equal(receipt.generation, 1); assert.equal(receipt.runId, writer.runId);
  assert.deepEqual(f.objects.get(receipt.key), new Uint8Array([1, 2]));
});

test("parallel staging of the same key converges without overwriting; encoded identifiers stay distinct", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () => stage(f.store)));
  assert.equal(f.objects.size, 1);
  for (const result of results) assert.deepEqual(result, results[0]);
  const raw = await stage(f.store, "original", "case%2Fother");
  const unicode = await stage(f.store, "original", "caso-á");
  assert.ok(raw.key.includes("case%252Fother"));
  assert.ok(unicode.key.includes("caso-%C3%A1"));
  assert.notEqual(raw.key, unicode.key);
});

test("invalid identities, paths, unstable bytes, sizes and hashes fail before storage", async () => {
  const f = fixture();
  for (const caseId of ["", ".", "..", "a/b", "a\\b", "a\n", "a:b"]) await assert.rejects(stage(f.store, "original", caseId));
  for (const generation of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(stage(f.store, "original", "fixture", generation));
  for (const badPath of ["quick/../result", "quick/.sha256/a", "case.zip", "quick//a", "quick/a\\b", "evidence/a:b"]) await assert.rejects(stageGenerationArtifact(f.store, "fixture", writer, badPath, "original", sha256("original")));
  await assert.rejects(stageGenerationArtifact(f.store, "fixture", writer, path, "changed", sha256("original")), /bytes\/hash mismatch/);
  await assert.rejects(stageGenerationArtifact(f.store, "fixture", writer, path, "original", sha256("original").toUpperCase()), /bytes\/hash mismatch/);
  await assert.rejects(stageGenerationArtifact(f.store, "fixture", writer, path, new Uint8Array(8 * 1024 * 1024 + 1), sha256("")), /8 MiB/);
  await assert.rejects(stageGenerationArtifact(f.store, "fixture", writer, path, new Uint8Array(new SharedArrayBuffer(1)), sha256("")), /stable bytes/);
  assert.deepEqual(f.calls, []);
});

test("lost upload response is resolved only by exact bytes; absence/read failure stays uncertain", async () => {
  const f = fixture();
  const responseLost: GenerationObjectStore = {
    async createOnly(key, bytes) { await f.store.createOnly(key, bytes); throw new Error("response lost"); }, read: f.store.read,
  };
  const receipt = await stage(responseLost);
  assert.deepEqual(await stage(f.store), receipt);
  for (const store of [
    { async createOnly() { throw new Error("no response"); }, async read() { return undefined; } },
    { createOnly: f.store.createOnly, async read() { throw new Error("read failed"); } },
    { async createOnly() {}, async read() { return undefined; } },
  ]) await assert.rejects(stage(store), (e: unknown) => (e as { reason: string }).reason === "generation_artifact_uncertain");
  assert.equal(f.objects.size, 1); // Retained even after an uncertain read.
});

test("conflicting/corrupt bytes are never overwritten, repaired or deleted", async () => {
  const f = fixture();
  const receipt = await stage(f.store);
  for (const corrupt of ["corrupt!", "short", "original-extra"]) {
    f.objects.set(receipt.key, new TextEncoder().encode(corrupt));
    await assert.rejects(stage(f.store), (e: unknown) => (e as { reason: string }).reason === "generation_artifact_conflict");
    assert.equal(new TextDecoder().decode(f.objects.get(receipt.key)), corrupt);
  }
  const failedAfterWrite = { ...f.store, async createOnly(key: string, bytes: Uint8Array) { f.objects.set(key, bytes); throw new Error("lost"); }, async read() { return undefined; } };
  await assert.rejects(stage(failedAfterWrite, "new"), /uncertain/);
  assert.equal(f.objects.size, 2); // No orphan GC.
});

test("R2 signing and create-only/readback contract can be exercised solely on a loopback fake", async (t) => {
  const r2 = await startFakeR2(); t.after(() => r2.close());
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(new URL(String(url)).hostname, "127.0.0.1");
    return fetch(url, options);
  });
  r2.store("cases/fixture/quick/answer/result.json", Buffer.from("legacy"));
  r2.store(`cases/fixture/.sha256/${sha256("legacy")}/${path}.json`, Buffer.from(JSON.stringify({ path, sha256: sha256("legacy") })));
  const transport: GenerationObjectStore = { async createOnly(key, bytes) { await putObject(key, bytes, { contentType: "application/octet-stream", overwrite: false }); }, read: getObject };
  const first = await stage(transport);
  assert.deepEqual(await stage(transport), first);
  const legacy = await caseArtifactStore.read("fixture");
  assert.deepEqual([...legacy.keys()], [path]);
  assert.equal(new TextDecoder().decode(legacy.get(path)), "legacy");
  assert.equal(r2.objects.get("cases/fixture/quick/answer/result.json")!.body.toString(), "legacy");
  const puts = r2.requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 2);
  for (const put of puts) {
    assert.equal(put.headers["if-none-match"], "*");
    assert.ok(String(put.headers.authorization).includes("if-none-match"));
    assert.equal(put.headers["x-amz-content-sha256"], first.sha256);
  }
  assert.equal(r2.requests.some((r) => r.method === "POST" || r.method === "DELETE" || r.headers["x-amz-copy-source"]), false);
});

test("remote entry and preflight block without any external call or checkpoint promotion", async (t) => {
  let effects = 0;
  t.mock.method(globalThis, "fetch", async () => { effects++; throw new Error("forbidden"); });
  await assert.rejects(stageCaseGenerationArtifact("fixture", writer, path, "original", sha256("original")), /retention_unproved/);
  assert.equal(generationArtifactPreflight().continuationEnabled, false);
  assert.equal(generationArtifactPreflight().state, "blocked");
  assert.equal(effects, 0);
});
