import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { findEvidenceArchive, hasEvidenceBase, writeCaseTranscript, writeEvidenceArchive } from "./blob.ts";
import { startFakeR2 } from "./r2-fake.ts";

test("stores and locates the public ZIP separately from the evidence tree in R2", async (t) => {
  const database = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => ({ rows: sql.startsWith("SELECT id, continuation_generation") ? [{ id: "case 1" }] : [] }),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const r2 = await startFakeR2();
  t.after(() => r2.close());
  r2.store("cases/case%201/evidence/base/index.md", Buffer.from("# Index"));

  assert.equal(await findEvidenceArchive("case 1"), undefined);
  assert.equal(await hasEvidenceBase("case 1"), true);
  assert.equal(await hasEvidenceBase("other"), false);
  const archive = await writeEvidenceArchive("case 1", Uint8Array.of(1, 2, 3));
  const zip = r2.objects.get("cases/case%201/case.zip")!;
  assert.deepEqual(archive, { downloadUrl: "https://public.test/cases/case%25201/case.zip", etag: zip.etag });
  assert.equal(zip.contentType, "application/zip");
  assert.equal(zip.cacheControl, "public, max-age=60");
  assert.equal(zip.contentDisposition, 'attachment; filename="case.zip"');
  assert.deepEqual(zip.body, Buffer.from([1, 2, 3]));
  assert.ok(!r2.requests.some((request) => request.method === "PUT" && request.headers["if-none-match"]));
  assert.deepEqual(await findEvidenceArchive("case 1"), archive);
  await writeCaseTranscript("case 1", '{"type":"statement"}\n');
  const transcript = r2.objects.get("cases/case%201/transcript.jsonl")!;
  assert.equal(transcript.contentType, "application/x-ndjson; charset=utf-8");
  assert.equal(transcript.body.toString(), '{"type":"statement"}\n');
  r2.state.deny = true;
  await assert.rejects(findEvidenceArchive("case 1"), /R2 head failed: 403/);
});
