import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { startFakeR2 } from "../evidence/r2-fake.ts";
import { playTurn } from "./play.ts";

test("persists every returned web research step as part of the evidence tree", async (t) => {
  const database = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => ({ rows: sql.startsWith("SELECT id, continuation_generation") ? [{ id: "case-1" }] : [] }),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const r2 = await startFakeR2();
  t.after(() => r2.close());
  const submission = { kind: "text" as const, text: "Una afirmación verificable para analizar." };
  const outcome = await playTurn("case-1", { submission, today: "hoy", simulated: true }, { kind: "instruction", counsel: "grok" }, [
    { type: "claims_entered", claims: [{ id: "A1", quote: "", text: submission.text }] },
  ], 0);
  assert.equal(outcome.done, true);
  const files = [...r2.objects].filter(([path]) => path.startsWith("cases/case-1/evidence/grok/research/"));
  assert.ok(files.length >= 2);
  const contents = files.map(([, object]) => JSON.parse(object.body.toString()));
  assert.ok(contents.every((entry) => entry.modelId === "court-fixture" && entry.effort === null && entry.seat === "grok" && entry.attempt === 0));
  assert.match(JSON.stringify(contents), /Documento de prueba con aportes/);
  for (const [path] of files) assert.ok([...r2.objects.keys()].some((key) => key.startsWith("cases/case-1/evidence/.sha256/") && key.endsWith(path.slice("cases/case-1/evidence/".length) + ".json")));
});
