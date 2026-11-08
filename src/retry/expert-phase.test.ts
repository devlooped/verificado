import assert from "node:assert/strict";
import test from "node:test";
import { PhaseSession } from "../court/phase-session.ts";
import { continuationHash } from "../domain/continuation.ts";
import { RETRY_CONTRACT_VERSION, retryCreationHash, type RetryCreation, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { RetryExpertPhaseRepository } from "./expert-phase.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";

const initial = { phase: "instruction", seat: "grok", channel: "decision", model: { id: "fixture/model" }, system: "system", tools: "{}", initial: "initial" } as const;
const key = "instruction:grok:decision";
const submission = { kind: "text", text: "synthetic", check: "expert" } as const;
async function active() {
  const configuration: RetryCreation["configuration"] = { check: "expert", pipelineVersion: 5, submission,
    models: { grok: { id: "fixture/model" } }, prompts: { instruction: "system" }, tools: {}, language: "es", today: "2026-11-07",
    budgets: { phase: 1 }, automaticRetries: { workflow: 0, ai: 0, provider: 0, broker: 0, sandbox: 0 } };
  const creation: RetryCreation = { version: RETRY_CONTRACT_VERSION, creation: { caseId: "case", nonce: "nonce", at: "2026-11-07T12:00:00.000Z", snapshotHash: "0".repeat(64) },
    configuration, configurationHash: continuationHash(configuration), initialStart: { requestKey: "start" } };
  creation.creation.snapshotHash = retryCreationHash(creation);
  const repo = new MemoryRetryRepository();
  await repo.create(creation, submission); await repo.claimStart("case", "start");
  await repo.registerStart("case", "start", { runId: "run", deploymentId: "deployment", world: "fixture" });
  await repo.observeStart("case", "start", { state: "returned", runId: "run" });
  const fence = await repo.reconcileStart("case", "start"); assert.ok(fence);
  return { repo, fence, adapter: new RetryExpertPhaseRepository(repo, fence, initial.initial) };
}
async function advance(repo: MemoryRetryRepository, fence: RetryFence): Promise<RetryFence> {
  const spec: RetryUnitSpec = { key: "fixture-failure", kind: "fixture", format: 1, dependencies: [], input: {}, effect: "external", estimatedCost: null };
  const claim = await repo.claimUnit(fence, spec); assert.equal(claim.state, "claimed"); if (claim.state !== "claimed") throw new Error("fixture");
  await repo.failUnit(fence, spec.key, claim.owner, { state: "proven_failed", reason: "fixture", inactivityProof: "fixture-proof" });
  const pause = await repo.beginPause(fence, spec.key, "fixture");
  await repo.confirmPause(fence, pause.id, { runId: "run", hookId: "hook", eventId: "registration" });
  const req = await repo.reserveRequest(fence, pause.id, "request", "admin");
  assert.equal(await repo.claimDispatch(fence, req.key), true);
  await repo.observeDispatch(fence, req.key, "delivered");
  const next = await repo.consumeRequest(fence, req.command); assert.ok(next); return next;
}

test("reopen restores all JSON fields and active turn identity, then reuses a completed turn", async () => {
  const { adapter } = await active();
  let session = await PhaseSession.open("case", initial, adapter);
  const identity = session.state.id;
  const turn = await session.begin("turn", [], "task", 12345);
  turn.results.call = { input: '["tool",{"a":1}]', output: { value: [1, null] } };
  turn.events.push({ type: "instruction_opened", at: "2026-11-07T12:00:00.000Z" });
  turn.inFlightStep = "fixture-step"; turn.answer = { step: 0, output: { text: "result" } };
  session.state.sandboxId = "sandbox-fixture";
  await session.save();
  const before = structuredClone(session.state);
  session = await PhaseSession.open("case", initial, adapter);
  assert.deepEqual(session.state, before);
  assert.strictEqual(session.state.activeTurn, session.state.turns.turn);
  await session.append([{ role: "assistant", content: "partial" }]);
  assert.equal(session.state.turns.turn.steps, 1);
  delete session.state.activeTurn!.inFlightStep;
  await session.finish();
  session = await PhaseSession.open("case", initial, adapter);
  const count = session.state.messages.length, expires = session.state.turns.turn.expiresAt;
  const reused = await session.begin("turn", [], "ignored on reuse");
  assert.equal(reused.complete, true); assert.equal(reused.expiresAt, expires);
  assert.deepEqual(reused.results.call.output, { value: [1, null] });
  assert.equal(session.state.messages.length, count); assert.equal(session.state.id, identity);
});

test("sequential revision CAS rejects stale and concurrent saves, including identical bodies", async () => {
  const { adapter } = await active();
  await PhaseSession.open("case", initial, adapter);
  const one = (await adapter.load("case", key))!, two = (await adapter.load("case", key))!;
  const outcomes = await Promise.allSettled([adapter.save("case", key, one.revision, one.body), adapter.save("case", key, two.revision, two.body)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  await assert.rejects(adapter.save("case", key, one.revision, one.body));
  assert.equal((await adapter.load("case", key))!.revision, 1);
});

test("same-run attempt change preserves checkpoints and rejects old writers", async () => {
  const { repo, fence, adapter } = await active();
  const session = await PhaseSession.open("case", initial, adapter);
  const turn = await session.begin("turn", [], "task", 18000);
  turn.results.call = { input: "[]", output: { complete: true } }; await session.save();
  const expected = structuredClone(session.state), before = await adapter.load("case", key);
  const next = await advance(repo, fence);
  await assert.rejects(adapter.load("case", key));
  await assert.rejects(adapter.save("case", key, before!.revision, before!.body));
  const nextAdapter = new RetryExpertPhaseRepository(repo, next, initial.initial);
  const resumed = await PhaseSession.open("case", initial, nextAdapter);
  assert.deepEqual(resumed.state, expected); assert.strictEqual(resumed.state.activeTurn, resumed.state.turns.turn);
  assert.equal(resumed.state.turns.turn.expiresAt, turn.expiresAt);
  await resumed.append([{ role: "assistant", content: "after retry" }]);
  assert.equal((await nextAdapter.load("case", key))!.revision, before!.revision + 1);
  assert.equal((await repo.read("case"))!.units.filter(u => u.kind === "expert.phase.checkpoint").length, before!.revision + 2);
});

test("unverified hashes, malformed result bodies, gaps and unfinished checkpoints block restoration", async () => {
  const { repo, fence, adapter } = await active();
  await PhaseSession.open("case", initial, adapter);
  const intercept = (edit: (record: NonNullable<Awaited<ReturnType<RetryRepository['read']>>>) => void): RetryRepository => new Proxy(repo, {
    get(target, prop) { if (prop === "read") return async (caseId: string) => { const record = await target.read(caseId); if (record) edit(record); return record; };
      const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value; },
  });
  const edits: Array<(r: NonNullable<Awaited<ReturnType<RetryRepository['read']>>>) => void> = [
    r => { r.units[0].resultHash = "bad"; },
    r => { const value = r.units[0].result as { body: { turns: unknown } }; value.body.turns = null; r.units[0].resultHash = continuationHash(value); },
    r => { const value = r.units[0].result as { body: { messages: unknown[] } }; value.body.messages[0] = { role: "user" }; r.units[0].resultHash = continuationHash(value); },
    r => { r.units[0].inputHash = "bad"; },
    r => { r.units[0].key = r.units[0].key.replace(/\/0$/, "/1"); },
    r => { r.units[0].state = "running"; delete r.units[0].result; delete r.units[0].resultHash; },
    r => { r.units.push(structuredClone(r.units[0])); },
  ];
  for (const edit of edits) await assert.rejects(new RetryExpertPhaseRepository(intercept(edit), fence, initial.initial).load("case", key));
  assert.ok(await adapter.load("case", key));
});

test("invalid results, lossy values, changed message prefix and wrong initial pin are rejected before writes", async () => {
  const { repo, fence, adapter } = await active();
  const session = await PhaseSession.open("case", initial, adapter);
  const turn = await session.begin("turn", [], "task");
  const revision = (await adapter.load("case", key))!.revision;
  turn.results.bad = { input: "not-json", output: null }; await assert.rejects(session.save());
  turn.results.bad = { input: "[]", output: new Uint8Array([1, 2]) }; await assert.rejects(session.save());
  delete turn.results.bad;
  session.state.messages[0].content = "changed"; await assert.rejects(session.save());
  assert.equal((await adapter.load("case", key))!.revision, revision);
  await assert.rejects(new RetryExpertPhaseRepository(repo, fence, "different").load("case", key));
  await assert.rejects(adapter.load("other", key));
});

test("an unfinished turn cannot erase or replace already saved results, events or sandbox identity", async () => {
  const { adapter } = await active();
  const session = await PhaseSession.open("case", initial, adapter);
  const turn = await session.begin("turn", [], "task");
  turn.results.call = { input: "[]", output: "original" };
  turn.events.push({ type: "instruction_opened", at: "2026-11-07T12:00:00.000Z" });
  session.state.sandboxId = "sandbox"; await session.save();
  const row = (await adapter.load("case", key))!;
  for (const edit of [
    (body: typeof row.body) => { delete body.turns.turn.results.call; },
    (body: typeof row.body) => { body.turns.turn.results.call.output = "replacement"; },
    (body: typeof row.body) => { body.turns.turn.events.length = 0; },
    (body: typeof row.body) => { body.sandboxId = "other"; },
  ]) {
    const body = structuredClone(row.body); edit(body);
    await assert.rejects(adapter.save("case", key, row.revision, body));
  }
  assert.equal((await adapter.load("case", key))!.revision, row.revision);
});

test("malformed turn results remain rejected even if their storage hashes are recomputed", async () => {
  const { repo, fence, adapter } = await active();
  const session = await PhaseSession.open("case", initial, adapter);
  const turn = await session.begin("turn", [], "task");
  turn.results.call = { input: "[]", output: "result" }; await session.save();
  const corrupt = new Proxy(repo, { get(target, prop) {
    if (prop === "read") return async (caseId: string) => {
      const record = await target.read(caseId);
      if (record) {
        const unit = record.units.at(-1)!;
        const value = unit.result as { body: { turns: Record<string, { results: Record<string, { output?: unknown }> }> } };
        delete value.body.turns.turn.results.call.output;
        // Also corrupt the redundant active copy, then recompute both hashes.
        const body = value.body as typeof value.body & { activeTurn: { results: Record<string, { output?: unknown }> } };
        delete body.activeTurn.results.call.output;
        (unit.input as { bodyHash: string }).bodyHash = continuationHash(body);
        unit.inputHash = continuationHash(unit.input); unit.resultHash = continuationHash(value);
      }
      return record;
    };
    const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(new RetryExpertPhaseRepository(corrupt, fence, initial.initial).load("case", key));
});

test("PhaseSession.open does not pass its initial prompt to the repository on reopen", async () => {
  const { adapter } = await active();
  await PhaseSession.open("case", initial, adapter);
  // This is an interface limitation, not authorization to use the result:
  // the caller must pin and compare open's input before invoking PhaseSession.
  const reopened = await PhaseSession.open("case", { ...initial, initial: "different" }, adapter);
  assert.equal(reopened.state.messages[0].content, initial.initial);
});

test("a persisted running checkpoint blocks rather than guessing whether it completed", async () => {
  const { repo, fence, adapter } = await active();
  await PhaseSession.open("case", initial, adapter);
  const original = repo.completeUnit.bind(repo);
  repo.completeUnit = async () => { throw new Error("lost completion"); };
  const current = (await adapter.load("case", key))!;
  await assert.rejects(adapter.save("case", key, current.revision, current.body), /lost completion/);
  repo.completeUnit = original;
  await assert.rejects(adapter.load("case", key));
  await assert.rejects(adapter.save("case", key, current.revision, current.body));
});
