import assert from "node:assert/strict";
import test from "node:test";
import type { RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "./execute.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { nextRetryQuickPlan, performPureRetryQuickUnit } from "./quick.ts";
import { retryFixtureCreation, retryFixtureReply } from "./test-fixture.ts";
import { driveRetryWorkflow, type RetryWorkflowHook, type RetryWorkflowSteps } from "./workflow-driver.ts";

async function fixture(identify = false) {
  const repo = new MemoryRetryRepository();
  const creation = retryFixtureCreation("driver", identify);
  const binding = { runId: "fixture-live-run", deploymentId: "fixture-deployment", world: "fixture" };
  await repo.create(creation, creation.configuration.submission as Parameters<RetryRepository["create"]>[1]);
  await repo.claimStart("driver", creation.initialStart.requestKey);
  await repo.registerStart("driver", creation.initialStart.requestKey, binding);
  await repo.observeStart("driver", creation.initialStart.requestKey, { state: "returned", runId: binding.runId });
  const fence = await repo.reconcileStart("driver", creation.initialStart.requestKey); assert.ok(fence);
  return { repo, fence };
}

function harness(repo: MemoryRetryRepository, perform: (spec: RetryUnitSpec) => Promise<unknown>, conflict = false) {
  const commands = new Map<string, unknown[]>();
  const registered = new Set<string>();
  const pauses: string[] = [];
  let disposed = 0;
  const accepted: Array<{ fence: RetryFence; command: unknown }> = [];
  const steps: RetryWorkflowSteps = {
    async load(fence) { const record = await repo.read(fence.caseId); assert.ok(record); assert.deepEqual(record.fence, fence); return nextRetryQuickPlan(record, { simulation: true }); },
    execute: (fence, spec) => executeRecordedUnit(repo, fence, spec, () => perform(spec)),
    skip: (fence, spec, reason) => repo.skipUnit(fence, spec, reason),
    publish: (fence, boundary) => repo.publishBoundary(fence, boundary),
    pause: (fence, key, reason) => repo.beginPause(fence, key, reason),
    async confirm(fence, pause) {
      assert.ok(registered.has(pause.token), "Exposure follows registration suspension");
      const record = await repo.read(fence.caseId); assert.ok(record);
      assert.equal(record.units.some(unit => unit.state === "running"), false, "All siblings settled before the pause");
      pauses.push(pause.unitKey);
      await repo.confirmPause(fence, pause.id, { runId: fence.runId, hookId: `hook-${pause.id}`, eventId: `event-${pause.id}` });
      const requests = await Promise.all([0, 1].map(() => repo.reserveRequest(fence, pause.id, `request-${pause.id}`, "fixture-admin")));
      assert.deepEqual(requests[0], requests[1]);
      const claims = await Promise.all(requests.map(request => repo.claimDispatch(fence, request.key)));
      assert.deepEqual(claims, [true, false]);
      await repo.observeDispatch(fence, requests[0].key, "uncertain");
      accepted.push({ fence, command: requests[0].command });
      commands.set(pause.token, [{ ...requests[0].command, requestKey: "unreserved" }, requests[0].command, requests[0].command]);
    },
    consume: (fence, command) => repo.consumeRequest(fence, command),
    block: (fence, reason) => repo.block(fence, reason),
    finish: fence => repo.finish(fence),
  };
  const hook = (token: string): RetryWorkflowHook => ({
    async getConflict() { if (!conflict) registered.add(token); return conflict ? { runId: "another-run" } : null; },
    async *[Symbol.asyncIterator]() { for (const command of commands.get(token) ?? []) yield command; },
    [Symbol.dispose]() { disposed++; },
  });
  return { steps, hook, pauses, accepted, disposed: () => disposed };
}

test("combined Quick/repository/driver completes all simulated routes on the original run", async () => {
  for (const identify of [false, true]) for (const split of [false, true]) {
    const { repo, fence } = await fixture(identify); const calls = new Map<string, number>();
    const h = harness(repo, async spec => {
      calls.set(spec.key, (calls.get(spec.key) ?? 0) + 1);
      return spec.effect === "pure" ? performPureRetryQuickUnit(spec) : retryFixtureReply(spec, split);
    });
    assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "finished", fence });
    const record = await repo.read("driver"); assert.ok(record);
    assert.equal(record.state, "finished"); assert.equal(record.fence?.runId, fence.runId);
    assert.equal([...calls.values()].every(count => count === 1), true);
    assert.equal(record.units.filter(unit => unit.state === "skipped").length, identify ? 8 : 9);
    const events = await repo.readEvents("driver");
    assert.deepEqual(events.map(event => event.seq), events.map((_event, i) => i + 1));
    assert.equal(events.at(-1)?.type, "session_closed"); assert.deepEqual(h.pauses, []);
  }
});

test("two failed seats need two pauses; completed seats and results survive duplicate/ambiguous signals", async () => {
  const { repo, fence } = await fixture(true);
  const validations = new Map<string, number>(); const dispatched = new Map<string, number>();
  const h = harness(repo, async spec => {
    const count = (validations.get(spec.key) ?? 0) + 1; validations.set(spec.key, count);
    if (["quick/answer/grok", "quick/answer/claude"].includes(spec.key) && count === 1) throw new RetryBeforeEffectFailure("fixture_unavailable");
    if (spec.effect === "pure") return performPureRetryQuickUnit(spec);
    dispatched.set(spec.key, (dispatched.get(spec.key) ?? 0) + 1);
    return retryFixtureReply(spec, true);
  });
  const finalFence = { ...fence, attempt: 2, epoch: 2 };
  assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "finished", fence: finalFence });
  assert.deepEqual(h.pauses, ["quick/answer/grok", "quick/answer/claude"]); assert.equal(h.disposed(), 2);
  assert.equal([...dispatched.values()].every(count => count === 1), true);
  assert.equal(validations.get("quick/answer/gemini"), 1); assert.equal(validations.get("quick/answer/chatgpt"), 1);
  for (const delivery of h.accepted) assert.equal(await repo.consumeRequest(delivery.fence, delivery.command), null);
  const record = await repo.read("driver"); assert.ok(record); assert.deepEqual(record.fence, finalFence);
  assert.equal(record.requests.filter(request => request.state === "accepted").length, 2);
  const events = await repo.readEvents("driver");
  assert.equal(events.filter(event => event.type === "quick_response").length, 4);
  assert.deepEqual(events.map(event => event.seq), events.map((_event, i) => i + 1));
  await assert.rejects(repo.claimUnit(fence, record.units[0]));
});

test("a provider response loss blocks after siblings settle and never creates a retry hook", async () => {
  const { repo, fence } = await fixture();
  const gate = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
  const h = harness(repo, async spec => {
    if (spec.key === "quick/answer/grok") throw new Error("Synthetic lost provider response");
    if (spec.key === "quick/answer/claude") { started.resolve(); await gate.promise; }
    return spec.effect === "pure" ? performPureRetryQuickUnit(spec) : retryFixtureReply(spec);
  });
  const running = driveRetryWorkflow(fence, h.steps, h.hook);
  await started.promise;
  assert.equal((await repo.read("driver"))?.state, "active"); gate.resolve();
  assert.deepEqual(await running, { state: "blocked", reason: "external_effect_uncertain" });
  const record = await repo.read("driver"); assert.ok(record);
  assert.equal(record.units.find(unit => unit.key === "quick/answer/claude")?.state, "ready");
  assert.equal(record.units.find(unit => unit.key === "quick/answer/grok")?.state, "uncertain");
  assert.deepEqual(record.fence, fence); assert.deepEqual(h.pauses, []);
  assert.equal((await repo.readEvents("driver")).length, 1, "No partial round is published");
});

test("a synchronous adapter throw still starts and waits for every sibling before blocking", async () => {
  const { repo, fence } = await fixture();
  const gate = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
  const h = harness(repo, async spec => spec.effect === "pure" ? performPureRetryQuickUnit(spec) : retryFixtureReply(spec));
  const execute = h.steps.execute, block = h.steps.block;
  const startedKeys: string[] = []; const pending: Promise<unknown>[] = []; let blocks = 0;
  h.steps.execute = (current, spec) => {
    startedKeys.push(spec.key);
    if (spec.key === "quick/answer/grok") {
      started.resolve();
      const delayed = gate.promise.then(() => execute(current, spec));
      pending.push(delayed); return delayed;
    }
    if (spec.key === "quick/answer/gemini") throw new Error("Synthetic synchronous adapter failure");
    return execute(current, spec);
  };
  h.steps.block = async (current, reason) => { blocks++; await block(current, reason); };
  const running = driveRetryWorkflow(fence, h.steps, h.hook);
  try {
    await started.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(blocks, 0, "Blocking must wait for the gated sibling");
    assert.ok(startedKeys.includes("quick/answer/claude"));
    assert.ok(startedKeys.includes("quick/answer/chatgpt"));
  } finally { gate.resolve(); await Promise.allSettled(pending); await running; }
  assert.deepEqual(await running, { state: "blocked", reason: "unit_protocol_failed" });
  const record = await repo.read("driver"); assert.ok(record);
  for (const seat of ["grok", "claude", "chatgpt"]) {
    assert.equal(record.units.find(unit => unit.key === `quick/answer/${seat}`)?.state, "ready");
  }
  assert.equal(blocks, 1); assert.deepEqual(record.fence, fence); assert.deepEqual(h.pauses, []);
});

test("hook conflict and registration/confirmation loss never expose or dispatch a retry", async () => {
  for (const conflict of [true, false]) {
    const { repo, fence } = await fixture();
    const h = harness(repo, async spec => {
      if (spec.key === "quick/answer/grok") throw new RetryBeforeEffectFailure("fixture_unavailable");
      return spec.effect === "pure" ? performPureRetryQuickUnit(spec) : retryFixtureReply(spec);
    }, conflict);
    if (!conflict) h.steps.confirm = async () => { throw new Error("Synthetic registration observation loss"); };
    assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "blocked", reason: conflict ? "hook_token_conflict" : "hook_registration_or_delivery_uncertain" });
    const record = await repo.read("driver"); assert.equal(record?.state, "blocked");
    assert.equal(record?.requests.length, 0); assert.equal(record?.pause?.hookId, null); assert.equal(h.disposed(), 1);
  }
});
