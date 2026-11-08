import assert from "node:assert/strict";
import test from "node:test";
import { continuationHash } from "../domain/continuation.ts";
import type { Submission } from "../domain/court.ts";
import { retryCreationHash, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "./execute.ts";
import { nextRetryExpertPlan, performPureRetryExpertUnit } from "./expert.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { RETRY_FIXTURE_AT, retryFixtureCreation } from "./test-fixture.ts";
import { driveRetryWorkflow, type RetryWorkflowHook, type RetryWorkflowSteps } from "./workflow-driver.ts";

async function fixture() {
  const repo = new MemoryRetryRepository();
  const creation = retryFixtureCreation("expert-simulation");
  creation.configuration.check = "expert";
  creation.configuration.submission = { kind: "text", text: "Synthetic case", check: "expert" };
  creation.configuration.prompts = Object.fromEntries(["preparation", "generation", "tool"].map(name => [`expert.simulation.${name}`, `Synthetic ${name}`]));
  creation.configuration.budgets = { intake: { deadline: "2026-11-07T12:05:00.000Z", maxCalls: 2 }, instruction: { deadline: "2026-11-07T12:06:00.000Z", maxCalls: 4 } };
  creation.configurationHash = continuationHash(creation.configuration);
  creation.creation.snapshotHash = retryCreationHash(creation);
  const binding = { runId: "fixture-same-run", deploymentId: "fixture-deployment", world: "fixture" };
  await repo.create(creation, creation.configuration.submission as Submission);
  await repo.claimStart(creation.creation.caseId, creation.initialStart.requestKey);
  await repo.registerStart(creation.creation.caseId, creation.initialStart.requestKey, binding);
  await repo.observeStart(creation.creation.caseId, creation.initialStart.requestKey, { state: "returned", runId: binding.runId });
  const fence = await repo.reconcileStart(creation.creation.caseId, creation.initialStart.requestKey); assert.ok(fence);
  return { repo, fence };
}

type Payload = { stage: "intake" | "instruction"; seat: string; attempt: number; call?: { id: string }; previous: unknown[] };
function reply(spec: RetryUnitSpec): unknown {
  if (spec.effect === "pure") return performPureRetryExpertUnit(spec);
  const { payload } = spec.input as { payload: Payload };
  const { stage, seat, attempt } = payload;
  if (spec.kind.endsWith("preparation")) return { startedAt: RETRY_FIXTURE_AT, expiresAt: "2026-11-07T12:05:00.000Z", at: RETRY_FIXTURE_AT,
    draft: `synthetic draft ${seat} ${attempt}`, messages: [{ role: "user", content: `turn ${attempt}` }], steps: 1 };
  if (spec.kind.endsWith("generation")) {
    const ids = seat === "chatgpt" && attempt === 0 ? [] : seat === "grok" ? ["proposal", "complete"] : ["complete"];
    return { at: RETRY_FIXTURE_AT, messages: [{ role: "assistant", content: `synthetic ${seat}` }], usage: { tokens: 1 },
      toolCalls: ids.map(id => ({ id, name: "synthetic_action", input: { seat, id } })) };
  }
  assert.equal(spec.kind, "expert.simulation.tool");
  const claim = { id: "A1", quote: "Synthetic", text: "Synthetic claim" };
  if (stage === "intake") return { at: RETRY_FIXTURE_AT, output: { admitted: true }, done: true, events: [{ type: "claims_entered", claims: [claim], at: RETRY_FIXTURE_AT }] };
  const proposal = { type: "evidence_proposed", by: seat, proposal: { claimId: "A1", url: `https://example.test/${seat}`, quote: "synthetic", stance: "context" }, at: RETRY_FIXTURE_AT };
  if (payload.call?.id === "proposal" || (seat === "claude" && attempt === 0)) return { at: RETRY_FIXTURE_AT, output: { filed: true }, done: false, events: [proposal] };
  return { at: RETRY_FIXTURE_AT, output: { completed: true }, done: true, events: [{ type: "instruction_completed", by: seat, searches: [], at: RETRY_FIXTURE_AT }] };
}

function harness(repo: MemoryRetryRepository, perform: (spec: RetryUnitSpec) => Promise<unknown>) {
  const commands = new Map<string, unknown[]>(); const pauses: string[] = []; const deliveries: Array<{ fence: RetryFence; command: unknown }> = [];
  const steps: RetryWorkflowSteps = {
    async load(fence) { const record = await repo.read(fence.caseId); assert.ok(record); assert.deepEqual(record.fence, fence); return nextRetryExpertPlan(record, { simulation: true }); },
    execute: (fence, spec) => executeRecordedUnit(repo, fence, spec, () => perform(spec)),
    skip: (fence, spec, reason) => repo.skipUnit(fence, spec, reason),
    publish: (fence, boundary) => repo.publishBoundary(fence, boundary),
    pause: (fence, key, reason) => repo.beginPause(fence, key, reason),
    async confirm(fence, pause) {
      assert.equal((await repo.read(fence.caseId))?.units.some(unit => unit.state === "running"), false);
      pauses.push(pause.unitKey);
      await repo.confirmPause(fence, pause.id, { runId: fence.runId, hookId: `hook-${pause.id}`, eventId: `event-${pause.id}` });
      const request = await repo.reserveRequest(fence, pause.id, `request-${pause.id}`, "fixture-admin");
      assert.equal(await repo.claimDispatch(fence, request.key), true);
      await repo.observeDispatch(fence, request.key, "uncertain");
      deliveries.push({ fence, command: request.command }); commands.set(pause.token, [request.command, request.command]);
    },
    consume: (fence, command) => repo.consumeRequest(fence, command),
    block: (fence, reason) => repo.block(fence, reason), finish: fence => repo.finish(fence),
  };
  const hook = (token: string): RetryWorkflowHook => ({ async getConflict() { return null; },
    async *[Symbol.asyncIterator]() { yield* commands.get(token) ?? []; }, [Symbol.dispose]() {} });
  return { steps, hook, pauses, deliveries };
}

test("same run preserves partial seats, attempts, tool outcomes and two separately authorized failures", async () => {
  const { repo, fence } = await fixture(); const calls = new Map<string, number>(); const dispatches = new Map<string, number>();
  const h = harness(repo, async spec => {
    const count = (calls.get(spec.key) ?? 0) + 1; calls.set(spec.key, count);
    if (["expert/instruction/grok/0/generation", "expert/instruction/claude/0/generation"].includes(spec.key) && count === 1) throw new RetryBeforeEffectFailure("synthetic_validation_failed");
    dispatches.set(spec.key, (dispatches.get(spec.key) ?? 0) + 1);
    return reply(spec);
  });
  const outcome = await driveRetryWorkflow(fence, h.steps, h.hook);
  assert.deepEqual(outcome, { state: "blocked", reason: "expert_simulation_remaining_procedure_unimplemented" });
  assert.deepEqual(h.pauses, ["expert/instruction/grok/0/generation", "expert/instruction/claude/0/generation"]);
  assert.ok([...dispatches.values()].every(count => count === 1));
  for (const delivery of h.deliveries) assert.equal(await repo.consumeRequest(delivery.fence, delivery.command), null);
  const record = await repo.read(fence.caseId); assert.ok(record);
  assert.deepEqual(record.fence, { ...fence, attempt: 2, epoch: 2 });
  assert.equal(record.requests.filter(request => request.state === "accepted").length, 2);
  const omitted = record.units.find(unit => unit.key === "expert/instruction/chatgpt/0/tool/none");
  assert.equal(omitted?.state, "skipped"); assert.equal(omitted?.reason, "simulation_no_tool_call");
  assert.equal(omitted?.result, undefined); assert.equal(omitted?.resultHash, undefined);
  const second = record.units.find(unit => unit.key === "expert/instruction/claude/1/preparation"); assert.ok(second);
  const input = second.input as { budgets: unknown; payload: { previous: unknown[] } };
  assert.equal(input.payload.previous.length, 1); assert.deepEqual(input.budgets, record.contract?.configuration.budgets);
  const events = await repo.readEvents(fence.caseId);
  assert.deepEqual(events.map(event => event.seq), events.map((_event, i) => i + 1));
  assert.deepEqual(events.map(event => event.type), ["session_opened", "claims_entered", "instruction_opened", "evidence_proposed", "instruction_completed", "instruction_completed", "evidence_proposed", "instruction_completed", "instruction_completed"]);
  assert.deepEqual(events.filter(event => event.type === "evidence_proposed").map(event => event.by), ["grok", "claude"]);
  assert.deepEqual(events.flatMap(event => event.type === "claims_entered" ? event.claims.map(claim => claim.id) : []), ["A1"]);
  // A published marker is not sufficient if an earlier phase result vanished.
  const missingDependency = structuredClone(record); missingDependency.state = "active";
  missingDependency.units = missingDependency.units.filter(unit => unit.key !== "expert/intake/judge/0/preparation");
  assert.deepEqual(nextRetryExpertPlan(missingDependency, { simulation: true }), { state: "blocked", reason: "expert_checkpoint_missing" });
});

test("timeout and lost response block with no pause or partial round publication", async () => {
  for (const message of ["synthetic timeout", "synthetic lost response", "generic error"]) {
    const { repo, fence } = await fixture(); const h = harness(repo, async spec => {
      if (spec.key === "expert/instruction/grok/0/generation") throw new Error(message);
      return reply(spec);
    });
    assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "blocked", reason: "external_effect_uncertain" });
    const record = await repo.read(fence.caseId); assert.ok(record);
    assert.equal(record.units.find(unit => unit.key === "expert/instruction/grok/0/generation")?.state, "uncertain");
    assert.equal(record.units.find(unit => unit.key === "expert/instruction/gemini/0/generation")?.state, "ready");
    assert.deepEqual(h.pauses, []); assert.deepEqual(record.fence, fence);
    assert.deepEqual((await repo.readEvents(fence.caseId)).map(event => event.type), ["session_opened", "claims_entered", "instruction_opened"]);
  }
});

test("expired, duplicate-call and incompatible-claim outcomes are not published", async () => {
  for (const defect of ["expired", "duplicate", "claim"] as const) {
    const { repo, fence } = await fixture();
    const h = harness(repo, async spec => {
      const value = await reply(spec) as Record<string, unknown>;
      if (spec.key === "expert/instruction/grok/0/generation") {
        if (defect === "expired") value.at = "2026-11-07T12:06:00.000Z";
        if (defect === "duplicate") value.toolCalls = [{ id: "same", name: "x", input: {} }, { id: "same", name: "y", input: {} }];
      }
      if (defect === "claim" && spec.kind === "expert.simulation.tool" && spec.key.startsWith("expert/instruction/grok/")) {
        const events = value.events as Array<{ type: string; proposal?: { claimId: string } }>;
        if (events[0]?.type === "evidence_proposed") events[0].proposal!.claimId = "missing";
      }
      return value;
    });
    assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "blocked", reason: "expert_result_invalid" });
    assert.deepEqual((await repo.readEvents(fence.caseId)).map(event => event.type), ["session_opened", "claims_entered", "instruction_opened"]);
    assert.deepEqual(h.pauses, []);
  }
});

test("lost unit publication response without durable result blocks and does not dispatch twice", async () => {
  const { repo, fence } = await fixture();
  let record = await repo.read(fence.caseId); assert.ok(record);
  const opening = nextRetryExpertPlan(record, { simulation: true }); assert.equal(opening.state, "units");
  if (opening.state !== "units") return;
  await executeRecordedUnit(repo, fence, opening.units[0], () => performPureRetryExpertUnit(opening.units[0]));
  record = await repo.read(fence.caseId); assert.ok(record);
  const publish = nextRetryExpertPlan(record, { simulation: true }); assert.equal(publish.state, "boundary");
  if (publish.state !== "boundary") return;
  await repo.publishBoundary(fence, publish.boundary);
  record = await repo.read(fence.caseId); assert.ok(record);
  const next = nextRetryExpertPlan(record, { simulation: true }); assert.equal(next.state, "units");
  if (next.state !== "units") return;
  const spec = next.units[0]; let calls = 0;
  const lossy = {
    claimUnit: repo.claimUnit.bind(repo), read: repo.read.bind(repo), failUnit: repo.failUnit.bind(repo),
    async completeUnit() { throw new Error("Synthetic lost publication"); },
  };
  assert.deepEqual(await executeRecordedUnit(lossy, fence, spec, async () => { calls++; return reply(spec); }),
    { state: "blocked", key: spec.key, reason: "result_publication_uncertain" });
  assert.deepEqual(await executeRecordedUnit(repo, fence, spec, async () => { calls++; return reply(spec); }),
    { state: "blocked", key: spec.key, reason: "uncertain" });
  assert.equal(calls, 1);
});

test("missing checkpoint, changed configuration and live or incompatible routes fail closed", async () => {
  const { repo, fence } = await fixture();
  let record = await repo.read(fence.caseId); assert.ok(record);
  assert.equal(nextRetryExpertPlan(record).state, "blocked");
  const first = nextRetryExpertPlan(record, { simulation: true }); assert.equal(first.state, "units");
  if (first.state !== "units") return;
  const unit = first.units[0];
  assert.equal((await executeRecordedUnit(repo, fence, unit, () => performPureRetryExpertUnit(unit))).state, "complete");
  record = await repo.read(fence.caseId); assert.ok(record);
  const opening = nextRetryExpertPlan(record, { simulation: true }); assert.equal(opening.state, "boundary");
  if (opening.state !== "boundary") return;
  assert.ok(opening.boundary.units.length); await repo.publishBoundary(fence, opening.boundary);
  record = await repo.read(fence.caseId); assert.ok(record);
  const missing = structuredClone(record); missing.units = [];
  assert.equal(nextRetryExpertPlan(missing, { simulation: true }).state, "blocked");
  const changed = structuredClone(record); changed.contract!.configuration.budgets = { altered: 1 };
  assert.equal(nextRetryExpertPlan(changed, { simulation: true }).state, "blocked");
  const corrupt = structuredClone(record); corrupt.cursor = { ...(corrupt.cursor as object), stage: "sources" };
  assert.equal(nextRetryExpertPlan(corrupt, { simulation: true }).state, "blocked");
  const noCursor = structuredClone(record); noCursor.cursor = null;
  assert.equal(nextRetryExpertPlan(noCursor, { simulation: true }).state, "blocked");
  const incompatible = structuredClone(record); incompatible.contract!.binding.world = "production";
  assert.equal(nextRetryExpertPlan(incompatible, { simulation: true }).state, "blocked");
});
