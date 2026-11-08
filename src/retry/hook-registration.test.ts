import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "@workflow/world";
import type { RetryRecord } from "../domain/retry-state.ts";
import { confirmRegisteredRetryPause, observeRetryHookRegistration, type RetryWorldReader } from "./hook-registration.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { retryFixtureCreation } from "./test-fixture.ts";

async function fixture() {
  const repo = new MemoryRetryRepository(), creation = retryFixtureCreation("fixture-registration");
  const id = creation.creation.caseId, key = creation.initialStart.requestKey;
  const binding = { runId: "fixture-run", deploymentId: "fixture-code", world: "fixture-world" };
  await repo.create(creation, creation.configuration.submission as Parameters<typeof repo.create>[1]);
  await repo.claimStart(id, key); await repo.registerStart(id, key, binding);
  await repo.observeStart(id, key, { state: "returned", runId: binding.runId });
  const fence = await repo.reconcileStart(id, key); assert.ok(fence);
  const unit = { key: "fixture-call", kind: "fixture", format: 1, input: {}, dependencies: [], effect: "external" as const, estimatedCost: null };
  const claim = await repo.claimUnit(fence, unit); assert.ok(claim.state === "claimed");
  await repo.failUnit(fence, unit.key, claim.owner, { state: "proven_failed", reason: "fixture_unavailable", inactivityProof: "fixture-only" });
  const pause = await repo.beginPause(fence, unit.key, "fixture_unavailable"), record = await repo.read(id); assert.ok(record);
  const run = { ...binding, status: "running" as const };
  const hook = { runId: binding.runId, hookId: "fixture-hook", token: pause.token };
  const event: Event = { eventType: "hook_created", runId: binding.runId, eventId: "fixture-registration", correlationId: hook.hookId,
    createdAt: new Date("2026-11-07T12:00:00Z"), eventData: { token: pause.token } };
  const reader: RetryWorldReader = { runs: { get: async () => run }, hooks: { getByToken: async () => hook },
    events: { listByCorrelationId: async () => ({ data: [event], cursor: null, hasMore: false }) } };
  return { repo, fence, pause, record, reader, run, hook, event };
}

test("World read verifies exact registration before durable pause confirmation and returns no token", async () => {
  const f = await fixture(); let pages = 0;
  f.reader.events.listByCorrelationId = async params => {
    assert.equal(params.runId, f.fence.runId); assert.equal(params.correlationId, f.hook.hookId); assert.equal(params.resolveData, "all");
    pages++;
    return pages % 2 === 1 ? { data: [], cursor: "next", hasMore: true } : { data: [f.event], cursor: null, hasMore: false };
  };
  assert.deepEqual(await observeRetryHookRegistration(f.record, "fixture-world", f.reader), { runId: f.run.runId, hookId: f.hook.hookId, eventId: f.event.eventId });
  assert.equal((await f.repo.read(f.fence.caseId))?.state, "pausing");
  await confirmRegisteredRetryPause(f.repo, f.fence, f.pause.id, "fixture-world", f.reader);
  assert.equal((await f.repo.read(f.fence.caseId))?.state, "paused");
});

test("registration fails closed on terminal/mismatched run, hook conflict, missing journal and forced/disposed hook", async () => {
  for (const status of ["pending", "completed", "failed", "cancelled"] as const) {
    const f = await fixture(); f.reader.runs.get = async () => ({ ...f.run, status });
    await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  }
  for (const patch of [{ runId: "other-run" }, { deploymentId: "other-code" }]) {
    const f = await fixture(); f.reader.runs.get = async () => ({ ...f.run, ...patch });
    await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  }
  for (const patch of [{ runId: "other-run" }, { token: "other-token" }, { hookId: "" }]) {
    const f = await fixture(); f.reader.hooks.getByToken = async () => ({ ...f.hook, ...patch });
    await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  }
  const f = await fixture();
  const disposed: Event = { ...f.event, eventType: "hook_disposed", eventData: { token: f.pause.token } };
  for (const data of [[], [f.event, f.event], [f.event, disposed], [{ ...f.event, eventData: { token: "other-token" } }],
    [{ ...f.event, eventData: { token: f.pause.token, force: true } }], [{ ...f.event, runId: "other-run" }]]) {
    f.reader.events.listByCorrelationId = async () => ({ data, cursor: null, hasMore: false });
    await assert.rejects(confirmRegisteredRetryPause(f.repo, f.fence, f.pause.id, "fixture-world", f.reader));
    assert.equal((await f.repo.read(f.fence.caseId))?.state, "pausing");
  }
  await assert.rejects(observeRetryHookRegistration(f.record, "other-world", f.reader));
});

test("registration rejects stalled pagination, stale fence/pause, changing run and changing token owner", async () => {
  const f = await fixture();
  f.reader.events.listByCorrelationId = async () => ({ data: [], cursor: "stalled", hasMore: true });
  await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  await assert.rejects(confirmRegisteredRetryPause(f.repo, { ...f.fence, epoch: 1 }, f.pause.id, "fixture-world", f.reader));
  await assert.rejects(confirmRegisteredRetryPause(f.repo, f.fence, "other-pause", "fixture-world", f.reader));
  f.reader.events.listByCorrelationId = async () => ({ data: [f.event], cursor: null, hasMore: false });
  let calls = 0;
  f.reader.runs.get = async () => ({ ...f.run, status: ++calls === 1 ? "running" : "failed" });
  await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  f.reader.runs.get = async () => f.run;
  f.reader.hooks.getByToken = async () => ({ ...f.hook, runId: ++calls === 3 ? f.run.runId : "other-run" });
  await assert.rejects(observeRetryHookRegistration(f.record, "fixture-world", f.reader));
  const other = await fixture();
  const wrongEvent = { ...other.record, pause: { ...other.pause, registrationEventId: "other-event" } } as RetryRecord;
  await assert.rejects(observeRetryHookRegistration(wrongEvent, "fixture-world", other.reader));
  other.reader.hooks.getByToken = async () => { throw new Error(`Private token ${other.pause.token}`); };
  await assert.rejects(observeRetryHookRegistration(other.record, "fixture-world", other.reader), { message: "Retry hook registration unverified" });
});
