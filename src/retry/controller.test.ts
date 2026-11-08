import assert from "node:assert/strict";
import test from "node:test";
import type { Submission } from "../domain/court.ts";
import { continuationHash } from "../domain/continuation.ts";
import { dispatchReservedRetry, inspectSameRunRetry, type RetryReadOnlyObserver } from "./controller.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "./execute.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { retryFixtureCreation } from "./test-fixture.ts";

async function fixture() {
  const repo = new MemoryRetryRepository(); const creation = retryFixtureCreation(); const id = creation.creation.caseId;
  await repo.create(creation, creation.configuration.submission as Submission); await repo.claimStart(id, creation.initialStart.requestKey);
  await repo.registerStart(id, creation.initialStart.requestKey, { runId: "fixture-run", deploymentId: "fixture-code", world: "fixture" });
  await repo.observeStart(id, creation.initialStart.requestKey, { state: "returned", runId: "fixture-run" });
  const fence = await repo.reconcileStart(id, creation.initialStart.requestKey); assert.ok(fence);
  await executeRecordedUnit(repo, fence, { key: "fixture-effect", kind: "fixture", format: 1, input: { private: "Synthetic private prompt" }, dependencies: [], effect: "external", estimatedCost: null }, async () => { throw new RetryBeforeEffectFailure("fixture_unavailable"); });
  const pause = await repo.beginPause(fence, "fixture-effect", "fixture_unavailable");
  await repo.confirmPause(fence, pause.id, { runId: fence.runId, hookId: "fixture-hook", eventId: "fixture-journal" });
  const observer: RetryReadOnlyObserver = {
    authorize: async () => true,
    observe: async () => ({ run: { runId: fence.runId, status: "running", deploymentId: "fixture-code", world: "fixture" }, hook: { runId: fence.runId, hookId: "fixture-hook", registrationInJournal: true, active: true }, deploymentAvailable: true, retentionVerified: true, quotaVerified: true, evidenceVerified: true, creationRecordedAtomically: true }),
    verifyInactivity: async unit => unit.inactivityProof === `not-dispatched:${continuationHash(unit.input)}`,
  };
  return { repo, id, fence, pause, observer };
}

test("admin inspection is read-only, gates permissions before reads, and never claims production readiness", async () => {
  const f = await fixture(); const before = await f.repo.read(f.id);
  const view = await inspectSameRunRetry(f.id, "fixture-admin", f.repo, f.observer);
  assert.equal(view.preflight.eligible, true); assert.deepEqual(view.preflight.reasons, ["route_disabled"]);
  assert.equal(view.preflight.estimatedPendingCost, null); assert.equal(view.runId, f.fence.runId);
  assert.deepEqual(await f.repo.read(f.id), before);
  assert.equal(JSON.stringify(view).includes("Synthetic private"), false); assert.equal(JSON.stringify(view).includes(f.pause.token), false);
  const denied = await inspectSameRunRetry(f.id, "not-admin", { read: async () => { throw new Error("Must not read"); } }, { ...f.observer, authorize: async () => false });
  assert.deepEqual(denied.preflight.reasons, ["not_admin"]);
  const legacy = await inspectSameRunRetry("AT-185-GA", "fixture-admin", new MemoryRetryRepository(["AT-185-GA"]), f.observer);
  assert.deepEqual(legacy.preflight.reasons, ["no_creation_contract"]);
});

test("terminal run, missing hook, unverified retention/inactivity and read failure stay blocked", async () => {
  const f = await fixture();
  const view = await inspectSameRunRetry(f.id, "fixture-admin", f.repo, { ...f.observer, verifyInactivity: async () => false, observe: async record => ({ ...await f.observer.observe(record), run: { runId: f.fence.runId, deploymentId: "fixture-code", world: "fixture", status: "failed" }, hook: null, retentionVerified: false }) });
  for (const reason of ["run_terminal", "hook_unconfirmed", "retention_unverified", "failure_unproved", "route_disabled"]) assert.ok(view.preflight.reasons.includes(reason as typeof view.preflight.reasons[number]));
  const lost = await inspectSameRunRetry(f.id, "fixture-admin", { read: async () => { throw new Error("Synthetic private error"); } }, f.observer);
  assert.deepEqual(lost.preflight.reasons, ["evidence_unverified"]);
});

test("one durable sender claim prevents redispatch after response loss or concurrent requests", async () => {
  for (const lost of [false, true]) {
    const f = await fixture(); const request = await f.repo.reserveRequest(f.fence, f.pause.id, "fixture-request", "fixture-admin"); let calls = 0;
    const resume = async (token: string) => { calls++; assert.equal(token, f.pause.token); if (lost) throw new Error("Synthetic response loss"); return { runId: f.fence.runId }; };
    const results = await Promise.all([0, 1].map(() => dispatchReservedRetry(f.repo, f.fence, request, resume)));
    assert.equal(calls, 1); assert.equal(results.filter(result => result.state === (lost ? "uncertain" : "delivered")).length, 1);
    await dispatchReservedRetry(f.repo, f.fence, request, resume); assert.equal(calls, 1);
    assert.ok(await f.repo.consumeRequest(f.fence, request.command));
    assert.equal((await dispatchReservedRetry(f.repo, f.fence, request, resume)).state, "accepted"); assert.equal(calls, 1);
  }
});
