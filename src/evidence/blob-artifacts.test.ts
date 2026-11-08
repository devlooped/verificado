import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { caseArtifactStore, writeEvidenceTree } from "./blob.ts";
import { startFakeR2 } from "./r2-fake.ts";

test("the R2 artifact boundary uses no-overwrite writes, accepts identical retries, and verifies all published hashes", async (t) => {
  const database = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({ query: async (sql: string) => ({ rows: sql.startsWith("SELECT id, continuation_generation") ? [{ id: "fixture" }] : [] }), release: () => {} })) as unknown as typeof Pool.prototype.connect);
  const r2 = await startFakeR2();
  t.after(() => r2.close());

  const files = new Map([["instruction/sources/src_a/original.bin", "source"], ["evidence/E1.md", "canonical"], ["discussion/grok/run/draft.md", "analysis"], ["case.json", '{"usage":[]}']]);
  await caseArtifactStore.write("fixture", files);
  await caseArtifactStore.write("fixture", files);
  const puts = r2.requests.filter((request) => request.method === "PUT");
  assert.ok(puts.length >= 16);
  assert.ok(puts.every((request) => request.headers["if-none-match"] === "*"));
  assert.deepEqual([...await caseArtifactStore.read("fixture")].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]), [...files].sort(([a], [b]) => a < b ? -1 : 1));
  await assert.rejects(caseArtifactStore.write("fixture", new Map([["evidence/E1.md", "changed"]])), /PreconditionFailed/);
  await assert.rejects(writeEvidenceTree("fixture", new Map([["evidence/E1.md", "changed"]])), /immutable host artifact writer/);
  r2.store("cases/fixture/evidence/partial.md", Buffer.from("unpublished"));
  assert.equal((await caseArtifactStore.read("fixture")).has("evidence/partial.md"), false);
  r2.store("cases/fixture/evidence/E1.md", Buffer.from("tampered"));
  await assert.rejects(caseArtifactStore.read("fixture"), /hash verification failed/);
});
