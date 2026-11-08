// Called ONLY by the guarded disposable Docker fixture, after its fresh DB,
// schema, role, server address and permitted socket have all been proved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PhaseSession } from "../src/court/phase-session.ts";
import { continuationHash } from "../src/domain/continuation.ts";
import type { Submission } from "../src/domain/court.ts";
import { retryCreationHash, type RetryFence, type RetryCreation } from "../src/domain/retry-contract.ts";
import type { RetryUnitSpec } from "../src/domain/retry-state.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "../src/retry/execute.ts";
import { RetryExpertPhaseRepository } from "../src/retry/expert-phase.ts";
import { installRetrySchema, PgRetryRepository } from "../src/retry/repository.ts";
import { nextRetryQuickPlan, performPureRetryQuickUnit } from "../src/retry/quick.ts";
import { retryFixtureCreation, retryFixtureReply } from "../src/retry/test-fixture.ts";
import { driveRetryWorkflow, type RetryWorkflowSteps } from "../src/retry/workflow-driver.ts";

export async function runRetryPostgresChecks(sql: Pool, check: (name: string, body: () => Promise<void>) => Promise<void>): Promise<void> {
  await installRetrySchema(sql);
  const repo = new PgRetryRepository(sql);
  const active = async (identify = false, expert = false) => {
    const creation = retryFixtureCreation("fixture-retry-" + randomUUID(), identify); const id = creation.creation.caseId;
    if (expert) {
      creation.configuration.check = "expert";
      creation.configuration.submission = { kind: "text", text: "Synthetic PostgreSQL-only phase", check: "expert" };
      creation.configurationHash = continuationHash(creation.configuration);
      creation.creation.snapshotHash = retryCreationHash(creation);
    }
    const binding = { runId: "fixture-retry-run-" + randomUUID(), deploymentId: "fixture-only-code", world: "fixture" };
    await repo.create(creation, creation.configuration.submission as Submission);
    assert.equal(await repo.claimStart(id, creation.initialStart.requestKey), true);
    await repo.registerStart(id, creation.initialStart.requestKey, binding);
    await repo.observeStart(id, creation.initialStart.requestKey, { state: "returned", runId: binding.runId });
    const fence = await repo.reconcileStart(id, creation.initialStart.requestKey); assert.ok(fence);
    return { id, fence, creation };
  };
  const spec: RetryUnitSpec = { key: "fixture-call", kind: "fixture.call", format: 1, dependencies: [], input: { prompt: "Synthetic PostgreSQL-only call" }, effect: "external", estimatedCost: null };
  const snapshot = async (id: string) => ({
    body: (await sql.query("SELECT body FROM case_retry_records WHERE case_id=$1", [id])).rows,
    events: (await sql.query("SELECT seq,at,body FROM events WHERE case_id=$1 ORDER BY seq", [id])).rows,
    audit: (await sql.query("SELECT operation,body_hash,details FROM case_retry_audit WHERE case_id=$1 ORDER BY id", [id])).rows,
  });

  await check("same-run PostgreSQL: exclusive creation, atomic evidence and one initial-start owner", async () => {
    const creation = retryFixtureCreation("fixture-create-" + randomUUID()); const id = creation.creation.caseId;
    const inserted = await Promise.allSettled([0, 1].map(() => repo.create(creation, creation.configuration.submission as Submission)));
    assert.equal(inserted.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await sql.query("SELECT retry_contract_version FROM cases WHERE id=$1", [id])).rows[0].retry_contract_version, creation.version);
    const claims = await Promise.all([0, 1, 2, 3].map(() => repo.claimStart(id, creation.initialStart.requestKey)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await repo.read(id))?.creation.configurationHash, creation.configurationHash);
    const legacy = await active();
    const changed: RetryCreation = { ...legacy.creation, configuration: { ...legacy.creation.configuration, submission: { kind: "text", text: "Changed" } } };
    await assert.rejects(repo.create(changed, changed.configuration.submission as Submission));
  });

  await check("same-run PostgreSQL: real row lock, four concurrent unit claims and exact completed reuse", async () => {
    const f = await active(), gate = await sql.connect(), other = await sql.connect();
    try {
      await gate.query("BEGIN"); await gate.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [f.id]);
      await other.query("BEGIN");
      await assert.rejects(other.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT", [f.id]), (error: unknown) => (error as { code?: string }).code === "55P03");
      await other.query("ROLLBACK");
    } finally { await gate.query("ROLLBACK"); gate.release(); other.release(); }
    const claims = await Promise.all([0, 1, 2, 3].map(() => repo.claimUnit(f.fence, spec)));
    assert.equal(claims.filter(claim => claim.state === "claimed").length, 1);
    const owner = claims.find(claim => claim.state === "claimed"); assert.ok(owner?.state === "claimed");
    await repo.completeUnit(f.fence, spec.key, owner.owner, { full: "Synthetic complete response", usage: { tokens: 10 } });
    const reused = await repo.claimUnit(f.fence, spec); assert.equal(reused.state, "reused");
    if (reused.state === "reused") assert.deepEqual(reused.unit.result, { full: "Synthetic complete response", usage: { tokens: 10 } });
    await assert.rejects(repo.claimUnit(f.fence, { ...spec, input: { prompt: "Changed" } }));
  });

  await check("same-run PostgreSQL: atomic events/cursor/audit rollback, collision and lost COMMIT response", async () => {
    const f = await active(); const claim = await repo.claimUnit(f.fence, spec); assert.ok(claim.state === "claimed");
    await repo.completeUnit(f.fence, spec.key, claim.owner, { full: "Stored response" });
    const before = await snapshot(f.id);
    await sql.query(`CREATE TABLE fixture_retry_faults (case_id text PRIMARY KEY);
      CREATE FUNCTION fixture_retry_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation='boundary' AND EXISTS (SELECT 1 FROM fixture_retry_faults WHERE case_id=NEW.case_id) THEN RAISE EXCEPTION 'fixture rollback' USING ERRCODE='P0001'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER fixture_retry_audit_fault BEFORE INSERT ON case_retry_audit FOR EACH ROW EXECUTE FUNCTION fixture_retry_audit_fault();`);
    await sql.query("INSERT INTO fixture_retry_faults VALUES ($1)", [f.id]);
    const boundary = { key: "fixture-boundary", units: [spec.key], expectedSeq: 1, cursor: { next: 1 }, events: [{ type: "instruction_opened" as const, seq: 1, at: "2026-11-07T12:00:00.000Z" }] };
    await assert.rejects(repo.publishBoundary(f.fence, boundary)); assert.deepEqual(await snapshot(f.id), before);
    await sql.query("DELETE FROM fixture_retry_faults WHERE case_id=$1", [f.id]);
    let responseLost = false;
    const losingPool = {
      query: sql.query.bind(sql),
      async connect() {
        const client = await sql.connect();
        return { async query(query: string, values?: unknown[]) { const result = await client.query(query, values); if (query === "COMMIT" && !responseLost) { responseLost = true; throw new Error("Synthetic lost COMMIT response"); } return result; }, release: () => client.release() };
      },
    } as unknown as Pool;
    await assert.rejects(new PgRetryRepository(losingPool).publishBoundary(f.fence, boundary)); assert.equal(responseLost, true);
    await repo.publishBoundary(f.fence, boundary);
    assert.deepEqual((await repo.read(f.id))?.cursor, { next: 1 });
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM events WHERE case_id=$1", [f.id])).rows[0].n, 1);
    await assert.rejects(repo.publishBoundary(f.fence, { ...boundary, cursor: { next: 2 } }));
    const stored = await snapshot(f.id);
    await sql.query("UPDATE case_retry_records SET body=jsonb_set(body,'{record,nextSeq}','900'::jsonb) WHERE case_id=$1", [f.id]);
    await assert.rejects(repo.read(f.id)); await assert.rejects(repo.claimUnit(f.fence, { ...spec, key: "after-corruption" }));
    assert.deepEqual((await snapshot(f.id)).events, stored.events);
  });

  await check("same-run PostgreSQL: Quick partial round, two separate authorizations, duplicate commands and late fencing", async () => {
    const f = await active(true), validated = new Map<string, number>(), dispatched = new Map<string, number>(), commands = new Map<string, unknown[]>();
    const consumed: Array<{ fence: RetryFence; command: unknown }> = [];
    const steps: RetryWorkflowSteps = {
      async load(fence) { const record = await repo.read(f.id); assert.ok(record); assert.deepEqual(record.fence, fence); return nextRetryQuickPlan(record, { simulation: true }); },
      execute: (fence, unit) => executeRecordedUnit(repo, fence, unit, async () => {
        const count = (validated.get(unit.key) ?? 0) + 1; validated.set(unit.key, count);
        if (["quick/answer/grok", "quick/answer/claude"].includes(unit.key) && count === 1) throw new RetryBeforeEffectFailure("fixture_unavailable");
        if (unit.effect === "pure") return performPureRetryQuickUnit(unit);
        dispatched.set(unit.key, (dispatched.get(unit.key) ?? 0) + 1); return retryFixtureReply(unit, true);
      }),
      skip: (fence, unit, reason) => repo.skipUnit(fence, unit, reason),
      publish: (fence, boundary) => repo.publishBoundary(fence, boundary),
      pause: (fence, key, reason) => repo.beginPause(fence, key, reason),
      async confirm(fence, pause) {
        assert.equal((await repo.read(f.id))?.units.some(unit => unit.state === "running"), false);
        await repo.confirmPause(fence, pause.id, { runId: fence.runId, hookId: "fixture-hook-" + pause.id, eventId: "fixture-event-" + pause.id });
        const requests = await Promise.all([0, 1].map(() => repo.reserveRequest(fence, pause.id, "fixture-request-" + pause.id, "fixture-admin")));
        assert.deepEqual(requests[0], requests[1]);
        assert.equal((await Promise.all(requests.map(request => repo.claimDispatch(fence, request.key)))).filter(Boolean).length, 1);
        await repo.observeDispatch(fence, requests[0].key, "uncertain");
        consumed.push({ fence, command: requests[0].command }); commands.set(pause.token, [requests[0].command, requests[0].command]);
      },
      consume: (fence, command) => repo.consumeRequest(fence, command),
      block: (fence, reason) => repo.block(fence, reason), finish: fence => repo.finish(fence),
    };
    assert.deepEqual(await driveRetryWorkflow(f.fence, steps, token => ({ getConflict: async () => null, async *[Symbol.asyncIterator]() { yield* commands.get(token) ?? []; }, [Symbol.dispose]() {} })), { state: "finished", fence: { ...f.fence, attempt: 2, epoch: 2 } });
    assert.equal([...dispatched.values()].every(count => count === 1), true);
    for (const request of consumed) assert.equal(await repo.consumeRequest(request.fence, request.command), null);
    const record = await repo.read(f.id); assert.ok(record); assert.equal(record.fence?.runId, f.fence.runId);
    await assert.rejects(repo.claimUnit(f.fence, spec));
    const events = (await sql.query("SELECT seq FROM events WHERE case_id=$1 ORDER BY seq", [f.id])).rows;
    assert.deepEqual(events.map(event => event.seq), events.map((_event, i) => i + 1));
    assert.equal(record.requests.filter(request => request.state === "accepted").length, 2);
  });

  await check("same-run PostgreSQL: Expert phase checkpoints, revision CAS, completed reuse and late fencing", async () => {
    const f = await active(false, true);
    const initial = { phase: "instruction", seat: "grok", channel: "decision", model: { id: "fixture/model" }, system: "synthetic", tools: "{}", initial: "synthetic phase input" } as const;
    const key = "instruction:grok:decision";
    const adapter = new RetryExpertPhaseRepository(repo, f.fence, initial.initial);
    let session = await PhaseSession.open(f.id, initial, adapter);
    const turn = await session.begin("fixture-turn", [], "synthetic task", 15000);
    turn.results.call = { input: '["synthetic",{"a":1}]', output: { full: [1, null, "synthetic outcome"] } };
    turn.events.push({ type: "instruction_opened", at: turn.startedAt });
    turn.inFlightStep = "fixture-step"; turn.draft = "synthetic partial draft";
    session.state.sandboxId = "fixture-identity-only-no-sandbox-created";
    await session.save();
    const expected = structuredClone(session.state), row = await adapter.load(f.id, key); assert.ok(row);
    const saves = await Promise.allSettled([0, 1, 2, 3].map(() => adapter.save(f.id, key, row.revision, structuredClone(row.body))));
    assert.equal(saves.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(saves.filter(result => result.status === "rejected").length, 3);
    await assert.rejects(adapter.save(f.id, key, row.revision, row.body));
    const before = await adapter.load(f.id, key); assert.ok(before);
    assert.equal(before.revision, row.revision + 1);
    assert.deepEqual(before.body, expected); assert.strictEqual(before.body.activeTurn, before.body.turns[turn.id]);

    const failed = { ...spec, key: "fixture-phase-failure" };
    assert.equal((await executeRecordedUnit(repo, f.fence, failed, async () => { throw new RetryBeforeEffectFailure("fixture_unavailable"); })).state, "paused");
    const pause = await repo.beginPause(f.fence, failed.key, "fixture_unavailable");
    await repo.confirmPause(f.fence, pause.id, { runId: f.fence.runId, hookId: "fixture-phase-hook", eventId: "fixture-phase-registration" });
    const request = await repo.reserveRequest(f.fence, pause.id, "fixture-phase-request", "fixture-admin");
    assert.equal(await repo.claimDispatch(f.fence, request.key), true);
    await repo.observeDispatch(f.fence, request.key, "delivered");
    const nextFence = await repo.consumeRequest(f.fence, request.command); assert.ok(nextFence);
    assert.deepEqual(nextFence, { ...f.fence, attempt: 1, epoch: 1 });
    assert.equal(await repo.consumeRequest(f.fence, request.command), null);
    const unchanged = await snapshot(f.id);
    await assert.rejects(adapter.load(f.id, key));
    await assert.rejects(adapter.save(f.id, key, before.revision, before.body));
    assert.deepEqual(await snapshot(f.id), unchanged);
    const nextAdapter = new RetryExpertPhaseRepository(repo, nextFence, initial.initial);
    session = await PhaseSession.open(f.id, initial, nextAdapter);
    assert.deepEqual(session.state, expected); assert.strictEqual(session.state.activeTurn, session.state.turns[turn.id]);
    delete session.state.activeTurn!.inFlightStep;
    await session.append([{ role: "assistant", content: "synthetic continuation" }]);
    await session.finish();
    session = await PhaseSession.open(f.id, initial, nextAdapter);
    const completed = await snapshot(f.id);
    const reused = await session.begin(turn.id, [], "must not replace completed task", 999999);
    assert.equal(reused.complete, true); assert.equal(reused.expiresAt, turn.expiresAt);
    assert.deepEqual(reused.results.call, turn.results.call);
    assert.deepEqual(await snapshot(f.id), completed);

    // Lose the response after the SECOND real COMMIT: claim first, result next.
    let commits = 0;
    const losingPool = { query: sql.query.bind(sql), async connect() {
      const client = await sql.connect();
      return { async query(query: string, values?: unknown[]) {
        const result = await client.query(query, values);
        if (query === "COMMIT" && ++commits === 2) throw new Error("Synthetic lost phase result COMMIT response");
        return result;
      }, release: () => client.release() };
    } } as unknown as Pool;
    const lostAdapter = new RetryExpertPhaseRepository(new PgRetryRepository(losingPool), nextFence, initial.initial);
    const latest = await nextAdapter.load(f.id, key); assert.ok(latest);
    await assert.rejects(lostAdapter.save(f.id, key, latest.revision, latest.body)); assert.equal(commits, 2);
    const restored = await nextAdapter.load(f.id, key); assert.ok(restored);
    assert.equal(restored.revision, latest.revision + 1); assert.deepEqual(restored.body, latest.body);
    await assert.rejects(nextAdapter.save(f.id, key, latest.revision, latest.body));
    assert.deepEqual(await nextAdapter.load(f.id, key), restored);
  });
}
