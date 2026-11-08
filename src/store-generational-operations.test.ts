import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { sourceOperationRepositoryFor } from "./store.ts";
import { continuationHash, continuationJson } from "./domain/continuation.ts";
import type { Operation } from "./instruction/source-store.ts";

// Actual store functions with an in-memory SQL double, not a runtime DB seam.
// BEGIN serialization models the case lock; it does NOT establish PostgreSQL
// isolation/locking semantics. All Pool and fetch calls are intercepted.
function fixture(t: TestContext) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const row = { id: "fixture", continuation_generation: 1, workflow_run_id: "run", status: "in_session", stopped_workflow_run_id: null as string | null };
  const generation = { state: "running", run_id: "run", reconciled_run_id: "run" };
  const state = { operations: new Map<string, Operation>(), aliases: new Map<string, string>(), audit: new Map<string, string>() };
  const faults = { lostCommit: false, update: false, audit: false };
  const calls: string[] = [];
  let queue = Promise.resolve(), releases = 0, external = 0;
  const direct = (sql: string, args: unknown[] = [], data = state) => {
    calls.push(sql);
    if (sql.startsWith("SELECT id, continuation_generation")) return { rows: row.id ? [{ ...row }] : [] };
    if (sql.startsWith("SELECT state, run_id, reconciled_run_id")) return { rows: [{ ...generation }] };
    const key = JSON.stringify(args.slice(0, 2));
    if (sql.startsWith("SELECT case_id, operation_key, body FROM case_source_operations")) {
      assert.equal(sql, "SELECT case_id, operation_key, body FROM case_source_operations WHERE case_id = $1 FOR UPDATE");
      assert.equal(args.length, 1, "no candidate filtering on physical/body/logical keys");
      return { rows: [...data.operations].flatMap(([id, body]) => {
        const [case_id, operation_key] = JSON.parse(id) as string[];
        return case_id === args[0] ? [{ case_id, operation_key, body: structuredClone(body) }] : [];
      }) };
    }
    if (sql.startsWith("INSERT INTO case_source_operations")) {
      if (!data.operations.has(key)) data.operations.set(key, JSON.parse(String(args[2])));
      return { rows: [] };
    }
    if (sql.startsWith("SELECT body FROM case_source_operations")) {
      const body = data.operations.get(key);
      return { rows: body ? [{ body: structuredClone(body) }] : [] };
    }
    if (sql.startsWith("UPDATE case_source_operations")) {
      if (faults.update) throw new Error("Injected update failure");
      data.operations.set(key, JSON.parse(String(args[2]))); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO case_continuation_audit")) {
      if (faults.audit) throw new Error("Injected audit failure");
      const id = JSON.stringify(args.slice(0, 3)), body = String(args[3]);
      if (data.audit.has(id) && data.audit.get(id) !== body) return { rows: [], rowCount: 0 };
      data.audit.set(id, body); return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO case_source_aliases")) {
      if (!data.aliases.has(key)) data.aliases.set(key, String(args[2]));
      return { rows: [{ source_id: data.aliases.get(key) }] };
    }
    if (sql.startsWith("SELECT source_id FROM case_source_aliases")) {
      const source_id = data.aliases.get(key);
      return { rows: source_id ? [{ source_id }] : [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  t.mock.method(globalThis, "fetch", async () => { external++; throw new Error("Network forbidden"); });
  t.mock.method(Pool.prototype, "query", (async (sql: string, args?: unknown[]) => {
    // Only schema setup is accepted outside a transaction for new-path tests.
    if (sql.includes("CREATE TABLE IF NOT EXISTS cases")) return { rows: [] };
    if (sql.startsWith("SELECT case_id, seq, body FROM events")) return { rows: [] };
    return direct(sql, args);
  }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => {
    let pending: typeof state | undefined, unlock: (() => void) | undefined;
    const finish = () => { unlock?.(); unlock = undefined; pending = undefined; };
    return {
      async query(sql: string, args?: unknown[]) {
        if (sql === "BEGIN") {
          const prior = queue;
          queue = new Promise<void>((resolve) => { unlock = resolve; });
          await prior;
          pending = structuredClone(state); calls.push(sql); return { rows: [] };
        }
        if (sql === "COMMIT") {
          assert.ok(pending); Object.assign(state, pending); calls.push(sql); finish();
          if (faults.lostCommit) { faults.lostCommit = false; throw new Error("COMMIT response lost"); }
          return { rows: [] };
        }
        if (sql === "ROLLBACK") { calls.push(sql); finish(); return { rows: [] }; }
        assert.ok(pending, "every writer/read query uses a transaction");
        return direct(sql, args, pending);
      },
      release() { releases++; finish(); },
    };
  }) as unknown as typeof Pool.prototype.connect);
  t.after(() => { assert.equal(external, 0); });
  const writer = { generation: 1, runId: "run" };
  const repo = sourceOperationRepositoryFor(writer);
  const input = { model: "fixture/model", prompt: "Stable input", deadline: "2026-11-07T12:00:00Z", maxRetries: 0 };
  const claim = (key = "call", stage = "sandbox-generation", value: unknown = input) => repo.claim("fixture", key, stage, 300_000, continuationHash(value), value);
  const stored = (key = "call") => state.operations.get(JSON.stringify(["fixture", `generation:1:${key}`]))!;
  return { repo, writer, row, generation, state, faults, calls, input, claim, stored, releases: () => releases };
}

test("generational claim durably copies full canonical input, owner and audit before returning", async (t) => {
  const f = fixture(t), original = structuredClone(f.input);
  const pending = f.claim();
  f.input.prompt = "Mutated while awaiting DB";
  f.writer.runId = "other"; f.writer.generation = 99;
  const result = await pending;
  assert.equal(result.owned, true);
  assert.equal(f.stored().inputJson, continuationJson(original));
  assert.equal(f.stored().inputHash, continuationHash(original));
  assert.deepEqual(f.stored().writer, { generation: 1, runId: "run" });
  assert.equal(Object.isFrozen(f.repo.writer), true);
  assert.equal(f.state.audit.size, 1);
  assert.ok(f.calls[1].startsWith("SELECT id, continuation_generation"));
  assert.ok(f.calls.findIndex((sql) => sql.startsWith("SELECT body")) > f.calls.findIndex((sql) => sql.startsWith("SELECT id")));
  assert.equal(f.calls.at(-1), "COMMIT");
  // Returned objects are detached, not live DB ownership tokens.
  result.operation.inputJson = "{}";
  assert.equal(f.stored().inputJson, continuationJson(original));
});

test("new intention requires exact input, valid hash, safe JSON and finite positive lease before DB", async (t) => {
  const f = fixture(t), hash = continuationHash(f.input);
  for (const args of [
    [hash, undefined], ["a".repeat(64), f.input], [undefined, f.input], [hash, { ...f.input, omitted: undefined }],
    [hash, new Proxy(f.input, {})],
  ] as const) await assert.rejects(f.repo.claim("fixture", "call", "stage", 1000, args[0], args[1]));
  for (const lease of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.5]) {
    await assert.rejects(f.repo.claim("fixture", "call", "stage", lease, hash, f.input), /Invalid continuation operation claim/);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.state.operations.size, 0);
  assert.throws(() => sourceOperationRepositoryFor({ generation: 0, runId: "run" }), /Invalid operation writer/);
});

test("concurrent identical claims have one owner, and changed input/stage never takes over", async (t) => {
  const f = fixture(t);
  const claims = await Promise.all(Array.from({ length: 8 }, () => f.claim()));
  assert.equal(claims.filter((c) => c.owned).length, 1);
  assert.equal(new Set(claims.map((c) => c.operation.owner)).size, 1);
  const before = structuredClone(f.stored());
  await assert.rejects(f.claim("call", "sandbox-generation", { ...f.input, prompt: "Other input" }), /input mismatch/);
  await assert.rejects(f.claim("call", "other-stage"), /stage mismatch/);
  assert.deepEqual(f.stored(), before);
});

test("lost COMMIT response leaves ownership durable and all retries blocked, including later expiry", async (t) => {
  const f = fixture(t); f.faults.lostCommit = true;
  await assert.rejects(f.claim(), /COMMIT response lost/);
  assert.equal(f.stored().status, "running");
  const owner = f.stored().owner;
  assert.equal((await f.claim()).owned, false);
  f.stored().expiresAt = new Date(0).toISOString();
  assert.equal((await f.repo.get("fixture", "call"))?.status, "uncertain");
  assert.equal((await f.claim()).owned, false);
  assert.equal(f.stored().owner, owner);
  await assert.rejects(f.repo.fail("fixture", "call", owner!, "lost", true), /ownership lost/);
  await assert.rejects(f.repo.recover("fixture", "call", "expired/cancelled"), /recovery blocked/);
});

test("a new generation never bypasses a predecessor, even expired, cancelled or labelled ready", async (t) => {
  const f = fixture(t); await f.claim();
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  for (const status of ["running", "uncertain", "failed", "ready", "pending"] as const) {
    f.stored().status = status; f.stored().expiresAt = new Date(0).toISOString();
    const before = structuredClone(f.state);
    await assert.rejects(next.claim("fixture", "call", "sandbox-generation", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
    assert.deepEqual(f.state, before);
  }
  // Legacy bodies have no writer and still cannot be implicitly adopted.
  f.state.operations.clear();
  f.state.operations.set(JSON.stringify(["fixture", "call"]), { key: "call", stage: "sandbox-generation", status: "uncertain", at: "2026-11-07", recoveries: [] });
  await assert.rejects(next.claim("fixture", "call", "sandbox-generation", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
});

test("intention and ownership rollback together on update or audit failure", async (t) => {
  const f = fixture(t);
  for (const fault of ["update", "audit"] as const) {
    f.faults[fault] = true;
    await assert.rejects(f.claim(), /Injected/);
    assert.equal(f.state.operations.size, 0); assert.equal(f.state.audit.size, 0);
    f.faults[fault] = false;
  }
  assert.equal((await f.claim()).owned, true);
});

test("corrupt predecessor key cannot disappear from the scan or acquire a new-generation owner", async (t) => {
  const f = fixture(t); await f.claim();
  const previous = structuredClone(f.stored());
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  for (const key of [undefined, "different", "generation:1:call"]) {
    f.state.operations.clear();
    const corrupt = structuredClone(previous);
    if (key === undefined) delete (corrupt as Partial<Operation>).key; else corrupt.key = key;
    f.state.operations.set(JSON.stringify(["fixture", "generation:1:call"]), corrupt);
    const before = structuredClone(f.state); f.calls.length = 0;
    await assert.rejects(next.claim("fixture", "call", "sandbox-generation", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.some((sql) => sql.startsWith("INSERT") || sql.startsWith("UPDATE")), false);
    assert.equal(f.calls.at(-1), "ROLLBACK");
  }
});

test("any malformed or ambiguous inventory row blocks new claims even when its apparent key is unrelated", async (t) => {
  const f = fixture(t); await f.claim();
  const good = { ...structuredClone(f.stored()), key: "independent" };
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  const rows: Array<[unknown, unknown]> = [
    ["generation:1:independent", null], ["generation:1:independent", []], ["generation:1:independent", "body"],
    ...[undefined, null, 1, {}, "altered"].map((key): [string, unknown] => ["generation:1:independent", { ...good, key }]),
    ...[undefined, null, {}, { generation: 0, runId: "run" }, { generation: 1.5, runId: "run" },
      { generation: 2, runId: "run2" }, { generation: 3, runId: "future" }, { generation: 1, runId: "" }]
      .map((writer): [string, unknown] => ["generation:1:independent", { ...good, writer }]),
    ...[null, 7, "renamed", "generation:01:independent", "generation:+1:independent", "generation:1e0:independent", "generation:1:other"]
      .map((physical): [unknown, unknown] => [physical, good]),
    ...[undefined, null, "done", "", 1].map((status): [string, unknown] => ["generation:1:independent", { ...good, status }]),
    ["generation:1:independent", { ...good, owner: undefined }], ["generation:1:independent", { ...good, expiresAt: "invalid" }],
    ["generation:1:independent", { ...good, status: "pending" }], ["generation:1:independent", { ...good, at: "invalid" }],
    ["generation:1:independent", { ...good, stage: null }], ["generation:1:independent", { ...good, recoveries: null }],
    ["generation:1:independent", { ...good, inputJson: undefined }], ["generation:1:independent", { ...good, inputHash: "wrong" }],
    ["generation:1:independent", { ...good, status: "ready", result: { partial: true } }],
    ["generation:2:independent", { ...good, writer: { generation: 2, runId: "different-run" } }],
    ["legacy", { key: "altered", stage: "legacy", status: "pending", at: good.at, recoveries: [] }],
  ];
  for (const [physical, body] of rows) {
    f.state.operations.clear();
    f.state.operations.set(JSON.stringify(["fixture", physical]), body as Operation);
    const before = structuredClone(f.state); f.calls.length = 0;
    await assert.rejects(next.claim("fixture", "fresh", "sandbox-generation", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.some((sql) => sql.startsWith("INSERT") || sql.startsWith("UPDATE")), false);
  }
});

test("reserved legacy prefixes and exact arbitrary logical-key predecessors remain blocked without wildcard matching", async (t) => {
  const f = fixture(t); await f.claim();
  const previous = structuredClone(f.stored());
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  for (const key of ["generation:1:call", "generation:2:call", "generation:01:call", "generation:", "generation:foo:%_"]) {
    f.state.operations.clear();
    f.state.operations.set(JSON.stringify(["fixture", key]), { key, stage: "legacy", status: "pending", at: previous.at, recoveries: [] });
    const before = structuredClone(f.state);
    for (const requested of ["call", "unrelated", key]) {
      await assert.rejects(next.claim("fixture", requested, "stage", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
      assert.deepEqual(f.state, before);
    }
  }
  for (const key of ["generation:1:call", "generation:", "%_", "call%", "call_", "call\\path", "a:b:c", "line\nbreak", "quote'\";--", "é", "e\u0301", "emoji🔒", " leading "]) {
    for (const legacy of [false, true]) {
      f.state.operations.clear();
      const body = legacy
        ? { key, stage: "legacy", status: "pending" as const, at: previous.at, recoveries: [] }
        : { ...previous, key };
      f.state.operations.set(JSON.stringify(["fixture", legacy ? key : `generation:1:${key}`]), body);
      const before = structuredClone(f.state);
      await assert.rejects(next.claim("fixture", key, "stage", 1000, continuationHash(f.input), f.input), /predecessor blocked/);
      assert.deepEqual(f.state, before);
    }
  }
});

test("only fully consistent independent rows pass the complete case inventory check", async (t) => {
  const f = fixture(t); await f.claim();
  const previous = structuredClone(f.stored());
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  const pairs = [["call%", "call"], ["call_", "call"], ["a:b:c", "c"], ["generation:1:call", "call"],
    ["é", "e\u0301"], ["xgeneration:1:call", "call"], ["quote'\";--", "quote"], ["line\nbreak", "line"]];
  for (const [priorKey, requested] of pairs) {
    f.state.operations.clear();
    f.state.operations.set(JSON.stringify(["fixture", `generation:1:${priorKey}`]), { ...previous, key: priorKey });
    // A different case's malformed row is outside the inventory boundary.
    f.state.operations.set(JSON.stringify(["other-case", "generation:1:call"]), null as unknown as Operation);
    f.calls.length = 0;
    assert.equal((await next.claim("fixture", requested, "stage", 1000, continuationHash(f.input), f.input)).owned, true);
    assert.deepEqual(f.state.operations.get(JSON.stringify(["fixture", `generation:1:${priorKey}`])), { ...previous, key: priorKey });
    assert.ok(f.calls.findIndex((sql) => sql.startsWith("SELECT case_id, operation_key")) > f.calls.findIndex((sql) => sql.startsWith("SELECT id, continuation_generation")));
  }
  for (const status of ["pending", "running", "failed", "uncertain", "ready"] as const) {
    f.state.operations.clear();
    const legacy: Operation = { key: "legacy%_generation:call", stage: "legacy", status, at: previous.at, recoveries: [],
      ...(status !== "pending" ? { owner: "legacy-owner", expiresAt: previous.expiresAt } : {}),
      ...(status === "ready" ? { result: { historical: true } } : {}) };
    f.state.operations.set(JSON.stringify(["fixture", legacy.key]), legacy);
    assert.equal((await next.claim("fixture", "fresh", "stage", 1000, continuationHash(f.input), f.input)).owned, true);
    assert.deepEqual(f.state.operations.get(JSON.stringify(["fixture", legacy.key])), legacy);
  }
});

test("concurrent claims cannot bypass a corrupt inventory; stale legacy writers cannot insert behind the case lock", async (t) => {
  const f = fixture(t); await f.claim();
  const previous = structuredClone(f.stored());
  f.row.continuation_generation = 2; f.row.workflow_run_id = "run2";
  f.generation.run_id = "run2"; f.generation.reconciled_run_id = "run2";
  const next = sourceOperationRepositoryFor({ generation: 2, runId: "run2" });
  const bad = { ...previous, key: "hidden" };
  f.state.operations.set(JSON.stringify(["fixture", "generation:1:call"]), bad);
  const before = structuredClone(f.state);
  const attempts = await Promise.allSettled([
    ...Array.from({ length: 8 }, (_, i) => next.claim("fixture", `fresh${i}%_`, "stage", 1000, continuationHash(f.input), f.input)),
    sourceOperationRepositoryFor().claim("fixture", "legacy", "stage", 1000),
  ]);
  assert.equal(attempts.every((r) => r.status === "rejected"), true);
  assert.deepEqual(f.state, before);
  f.state.operations.clear();
  f.state.operations.set(JSON.stringify(["fixture", "generation:1:independent"]), { ...previous, key: "independent" });
  const claims = await Promise.all(Array.from({ length: 8 }, () => next.claim("fixture", "fresh%_", "stage", 1000, continuationHash(f.input), f.input)));
  assert.equal(claims.filter((r) => r.owned).length, 1);
  assert.equal(new Set(claims.map((r) => r.operation.owner)).size, 1);
});

test("all generational reads/mutations fence stale case, generation, run, reconciliation and cancellation", async (t) => {
  const f = fixture(t); const claim = await f.claim(); assert.ok(claim.owned);
  const originalRow = { ...f.row }, originalGeneration = { ...f.generation };
  const requests = [
    () => f.repo.get("fixture", "missing"), () => f.repo.get("fixture", "call"),
    () => f.repo.resolve("fixture", "https://fixture.test"), () => f.repo.alias("fixture", "https://fixture.test", "src"),
    () => f.claim(), () => f.repo.fail("fixture", "call", claim.owner, "lost", true),
  ];
  const corruptions = [
    () => { f.row.id = ""; }, () => { f.row.continuation_generation = 2; }, () => { f.row.workflow_run_id = "other"; },
    () => { f.row.status = "failed"; }, () => { f.row.stopped_workflow_run_id = "run"; },
    () => { f.generation.state = "uncertain"; }, () => { f.generation.run_id = "other"; },
    () => { f.generation.reconciled_run_id = "other"; },
  ];
  for (const corrupt of corruptions) {
    Object.assign(f.row, originalRow); Object.assign(f.generation, originalGeneration); corrupt();
    for (const request of requests) {
      f.calls.length = 0;
      await assert.rejects(request(), /fenced|no existe/);
      assert.equal(f.calls.some((sql) => sql.includes("case_source_operations") || sql.includes("case_source_aliases")), false);
      assert.equal(f.calls.at(-1), "ROLLBACK");
    }
  }
  assert.equal(f.stored().status, "running");
});

test("body writer/key corruption and hash-only/missing intentions block reads and mutations", async (t) => {
  const f = fixture(t); const claimed = await f.claim(); assert.ok(claimed.owned);
  const original = structuredClone(f.stored());
  const corruptions = [
    (o: Operation) => { delete o.writer; }, (o: Operation) => { o.writer!.runId = "other"; },
    (o: Operation) => { o.writer!.generation = 2; }, (o: Operation) => { o.key = "other"; },
    (o: Operation) => { delete o.inputJson; }, (o: Operation) => { o.inputJson = "{}"; },
    (o: Operation) => { delete o.inputHash; }, (o: Operation) => { o.inputJson = JSON.stringify(f.input); },
    (o: Operation) => { delete o.owner; }, (o: Operation) => { delete o.expiresAt; },
    (o: Operation) => { o.status = "pending"; },
  ];
  for (const corrupt of corruptions) {
    Object.assign(f.stored(), structuredClone(original)); corrupt(f.stored());
    const before = structuredClone(f.stored());
    for (const request of [() => f.repo.get("fixture", "call"), () => f.claim(), () => f.repo.fail("fixture", "call", claimed.owner, "lost", true)]) {
      await assert.rejects(request()); assert.deepEqual(f.stored(), before);
    }
  }
});

test("lost/partial result stays uncertain even if caller requests known failure; no owner takeover", async (t) => {
  const f = fixture(t); const claim = await f.claim(); assert.ok(claim.owned);
  await assert.rejects(f.repo.fail("fixture", "call", "wrong-owner", "partial", true), /ownership lost/);
  assert.equal(f.stored().status, "running");
  await f.repo.fail("fixture", "call", claim.owner, "result response lost", false);
  assert.equal(f.stored().status, "uncertain");
  assert.equal((await f.claim()).owned, false);
  await assert.rejects(f.repo.fail("fixture", "call", claim.owner, "second response", true), /ownership lost/);
});

test("generational publish, defer and recovery reject before DB; synthetic ready is never reused", async (t) => {
  const f = fixture(t); const claim = await f.claim(); assert.ok(claim.owned);
  for (const result of [undefined, { partial: true }, { complete: true, artifact: "generation:1/result", hash: "a".repeat(64) }]) {
    f.calls.length = 0;
    await assert.rejects(f.repo.publish("fixture", "call", claim.owner, result), /ready publication blocked/);
    assert.equal(f.calls.length, 0);
  }
  f.calls.length = 0;
  await assert.rejects(f.repo.defer("fixture", "call", claim.owner), /defer blocked/);
  await assert.rejects(f.repo.recover("fixture", "call", "reviewed cancellation"), /recovery blocked/);
  assert.equal(f.calls.length, 0);
  f.stored().status = "ready"; f.stored().result = { complete: true };
  await assert.rejects(f.repo.get("fixture", "call"), /result reuse blocked/);
  await assert.rejects(f.claim(), /predecessor blocked/);
  assert.equal(f.stored().status, "ready", "no silent repair of unsafe rows");
});

test("generational alias conflicts roll back and resolve checks the writer inside the case transaction", async (t) => {
  const f = fixture(t);
  assert.equal(await f.repo.alias("fixture", "https://fixture.test", "src1"), "src1");
  await assert.rejects(f.repo.alias("fixture", "https://fixture.test", "src2"), /alias collision/);
  f.calls.length = 0;
  assert.equal(await f.repo.resolve("fixture", "https://fixture.test"), "src1");
  assert.equal(f.calls[0], "BEGIN"); assert.ok(f.calls[1].endsWith("FOR UPDATE")); assert.equal(f.calls.at(-1), "COMMIT");
});

test("legacy keys, optional hash-only claim, ready/recovery/defer behavior remain unchanged", async (t) => {
  const f = fixture(t); f.row.continuation_generation = 0;
  const legacy = sourceOperationRepositoryFor();
  let claim = await legacy.claim("fixture", "canonical", "canonical", 1000); assert.ok(claim.owned);
  await legacy.defer("fixture", "canonical", claim.owner);
  claim = await legacy.claim("fixture", "canonical", "canonical", 1000); assert.ok(claim.owned);
  await legacy.publish("fixture", "canonical", claim.owner, { exact: "legacy output" });
  assert.deepEqual((await legacy.get("fixture", "canonical"))?.result, { exact: "legacy output" });
  const failed = await legacy.claim("fixture", "external", "translation", 1000, "historical-hash"); assert.ok(failed.owned);
  await legacy.fail("fixture", "external", failed.owner, "known", false);
  assert.equal((await legacy.get("fixture", "external"))?.status, "failed");
  await legacy.recover("fixture", "external", "Legacy fixture review");
  assert.equal((await legacy.claim("fixture", "external", "translation", 1000, "historical-hash")).owned, true);
  assert.equal(f.state.audit.size, 0);
  assert.equal([...f.state.operations.values()].every((o) => !o.writer && o.inputJson === undefined), true);
});
