import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createMockSeat, createQuickMockModel } from "../court/mock.ts";
import { planTurn, type TurnSpec } from "../court/turns.ts";
import { turnPhase } from "../instruction/court-tools.ts";
import { COUNSEL, type RecordedEvent, type Submission } from "../domain/court.ts";
import { continuationHash } from "../domain/continuation.ts";
import { retryCreationHash, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "./execute.ts";
import { nextRetryExpertProcedurePlan, type RetryExpertTask, type RetryExpertWork } from "./expert-procedure.ts";
import { nextRetryExpertTurnWork } from "./expert-turn.ts";
import { executeRetryExpertUnit, type RetryExpertEffectAdapters } from "./expert-execute.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { performRetryExpertCourtTool } from "./expert-tool.ts";
import { RETRY_FIXTURE_AT, retryExpertFixtureCreation } from "./test-fixture.ts";
import { driveRetryWorkflow, type RetryWorkflowHook, type RetryWorkflowSteps } from "./workflow-driver.ts";

async function fixture() {
  const repo = new MemoryRetryRepository(), creation = retryExpertFixtureCreation();
  // All declarations, never execute callbacks. The local mock alone generates
  // these calls; tests use actual domain tool handlers on the next durable unit.
  const example: RecordedEvent[] = [{ type: "claims_entered", seq: 1, at: RETRY_FIXTURE_AT, claims: [{ id: "A1", quote: "", text: "Synthetic factual claim" }] }];
  const specs: TurnSpec[] = [{ kind: "intake" }, ...COUNSEL.flatMap<TurnSpec>(counsel => [{ kind: "statement", counsel, stage: "opening" },
    { kind: "closing", counsel }, { kind: "content_vote", counsel }, { kind: "objection", counsel, speaker: "grok", statementId: "I1" },
    { kind: "reply", speaker: counsel, objector: "claude", objectionId: "O1" }]), { kind: "ruling", objectionId: "O1" }, { kind: "summary" }];
  for (const spec of specs) {
    const plan = planTurn(spec, example, creation.configuration.submission as Submission, [], false, true);
    const seat = plan.seat, phase = spec.kind === "intake" ? "intake" : "debate", key = `expert.${phase}:${seat}:decision`;
    const current = creation.configuration.tools[key] as Record<string, unknown>;
    Object.assign(current, Object.fromEntries(Object.entries(plan.tools).map(([name, tool]) => [name, { description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(tool.schema, { target: "draft-7" }))) }])));
  }
  creation.configurationHash = continuationHash(creation.configuration); creation.creation.snapshotHash = retryCreationHash(creation);
  await repo.create(creation, creation.configuration.submission as Submission);
  const id = creation.creation.caseId, request = creation.initialStart.requestKey;
  await repo.claimStart(id, request); await repo.registerStart(id, request, { runId: "same-run", deploymentId: "fixture-deployment", world: "fixture" });
  await repo.observeStart(id, request, { state: "returned", runId: "same-run" });
  const fence = await repo.reconcileStart(id, request); assert.ok(fence);
  return { repo, fence };
}

function auxiliary(record: RetryRecord, task: RetryExpertTask): RetryExpertWork {
  if (task.kind === "turn") return nextRetryExpertTurnWork(record, task);
  // Explicit local fixtures for primitives whose productive adapters remain
  // blocked: no legacy collector, archive, sandbox or network function runs.
  const spec: RetryUnitSpec = { key: `${task.key}/fixture`, kind: `fixture.${task.kind}`, format: 1,
    effect: "external", dependencies: [], estimatedCost: null, input: { task, configurationHash: record.contract!.configurationHash } };
  const stored = record.units.find(unit => unit.key === spec.key);
  if (!stored || stored.state !== "ready") return { state: "pending", units: [spec] };
  assert.equal(stored.inputHash, continuationHash(spec.input)); assert.equal(stored.resultHash, continuationHash(stored.result));
  return { state: "complete", events: (stored.result as { events: Extract<RetryExpertWork, { state: "complete" }>["events"] }).events, done: true, units: [spec.key] };
}

function harness(repo: MemoryRetryRepository, before?: (spec: RetryUnitSpec) => Promise<void>, stopAfterInstruction = false) {
  const calls = new Map<string, number>(), pauses: string[] = [], commands = new Map<string, unknown[]>();
  let loads = 0;
  const models = new Map<string, ReturnType<typeof createMockSeat>["model"]>();
  const check = async (spec: RetryUnitSpec) => {
    await before?.(spec);
    calls.set(spec.key, (calls.get(spec.key) ?? 0) + 1);
    const record = await repo.read("expert-procedure"); assert.ok(record);
    assert.equal(record.units.find(unit => unit.key === spec.key)?.state, "running");
    return record;
  };
  const adapters: RetryExpertEffectAdapters = {
    async model(spec) {
      const record = await check(spec);
      const input = spec.input as { task: Extract<RetryExpertTask, { kind: "turn" }>; payload: { channel: string } };
      if (input.payload.channel === "preparation") return createQuickMockModel("answer");
      if (!models.has(input.task.key)) models.set(input.task.key, createMockSeat({ spec: input.task.spec, record: input.task.record,
        submission: record.contract!.configuration.submission as Submission, native: true }, false).model);
      return models.get(input.task.key)!;
    },
    async normalize(spec) { await check(spec); return { body: (spec.input as { payload: { text: string } }).payload.text }; },
    async tool(spec) {
      await check(spec);
      const task = (spec.input as { task: Extract<RetryExpertTask, { kind: "turn" }> }).task;
      return performRetryExpertCourtTool(spec, turnPhase(task.spec) === "debate" ? {
        manifest: { schemaVersion: 2, language: "es", documents: [], files: {} }, manifestHash: "a".repeat(64),
        index: "", question: "", documents: new Map(),
      } : undefined);
    },
  };
  const perform = async (spec: RetryUnitSpec): Promise<unknown> => {
    await check(spec);
    if (spec.kind === "fixture.sources") return { events: [{ type: "evidence_unified", sources: [], at: RETRY_FIXTURE_AT }] };
    if (spec.kind === "fixture.settle") return { events: [{ type: "evidence_settled", schemaVersion: 2, manifestHash: "a".repeat(64), at: RETRY_FIXTURE_AT }] };
    if (spec.kind === "fixture.post") return { events: [] };
    throw new Error("Unknown fixture primitive");
  };
  const steps: RetryWorkflowSteps = {
    async load(fence) {
      const record = await repo.read(fence.caseId); assert.ok(record); assert.deepEqual(record.fence, fence); assert.ok(++loads < 1000);
      // These focused failure tests terminate their fixture after instruction;
      // only the full-procedure test above claims verification through closure.
      if (stopAfterInstruction && (record.cursor as { stage?: string } | null)?.stage === "sources") return { state: "finished" };
      return nextRetryExpertProcedurePlan(record, auxiliary);
    },
    execute: (fence, spec) => spec.kind.startsWith("fixture.") ? executeRecordedUnit(repo, fence, spec, () => perform(spec)) :
      executeRetryExpertUnit(repo, fence, spec, adapters, auxiliary),
    skip: (fence, spec, reason) => repo.skipUnit(fence, spec, reason), publish: (fence, boundary) => repo.publishBoundary(fence, boundary),
    pause: (fence, unit, reason) => repo.beginPause(fence, unit, reason),
    async confirm(fence, pause) {
      assert.equal((await repo.read(fence.caseId))!.units.some(unit => unit.state === "running"), false);
      pauses.push(pause.unitKey); await repo.confirmPause(fence, pause.id, { runId: fence.runId, hookId: "hook", eventId: "registered" });
      const request = await repo.reserveRequest(fence, pause.id, `request-${pause.id}`, "admin");
      assert.equal(await repo.claimDispatch(fence, request.key), true); await repo.observeDispatch(fence, request.key, "uncertain");
      commands.set(pause.token, [request.command, request.command]);
    },
    consume: (fence, command) => repo.consumeRequest(fence, command), block: (fence, reason) => repo.block(fence, reason), finish: fence => repo.finish(fence),
  };
  const hook = (token: string): RetryWorkflowHook => ({ async getConflict() { return null; }, async *[Symbol.asyncIterator]() { yield* commands.get(token) ?? []; }, [Symbol.dispose]() {} });
  return { steps, hook, calls, pauses };
}

test("full new Expert procedure drives real SDK mocks and separately persisted tools through closure", async () => {
  const { repo, fence } = await fixture(), h = harness(repo);
  assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "finished", fence });
  const events = await repo.readEvents(fence.caseId), record = await repo.read(fence.caseId); assert.ok(record);
  assert.equal(events.filter(event => event.type === "instruction_closed").length, 1);
  assert.equal(events.filter(event => event.type === "session_closed").length, 1);
  assert.equal(events.filter(event => event.type === "statement").length, 12);
  assert.equal(events.filter(event => event.type === "case_summary").length, 1);
  assert.equal(events.filter(event => event.type === "objection").length, 1);
  assert.equal(events.filter(event => event.type === "ruling").length, 1);
  assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index + 1));
  assert.ok([...h.calls.values()].every(count => count === 1));
  assert.ok(record.units.filter(unit => unit.kind === "expert.turn.tool").every(unit => unit.dependencies.some(key => key.endsWith("/generation"))));
});

test("two instruction failures resume only their own primitives, preserving complete generations and siblings", async () => {
  const { repo, fence } = await fixture(), failed = new Set<string>();
  const h = harness(repo, async spec => {
    const task = (spec.input as { task?: Extract<RetryExpertTask, { kind: "turn" }>; payload?: { channel?: string } }).task;
    if (spec.kind === "expert.turn.generation" && task?.kind === "turn" && task.spec.kind === "instruction" &&
      ["grok", "claude"].includes(task.spec.counsel) && (spec.input as { payload: { channel: string } }).payload.channel === "decision" && !failed.has(spec.key)) {
      failed.add(spec.key); throw new RetryBeforeEffectFailure("fixture_not_dispatched");
    }
  }, true);
  const outcome = await driveRetryWorkflow(fence, h.steps, h.hook);
  assert.equal(outcome.state, "finished");
  assert.equal(h.pauses.length, 4, "each reasoning and typed generation needs its own authorization");
  assert.ok([...h.calls.values()].every(count => count === 1));
  const record = (await repo.read(fence.caseId))!;
  assert.equal(record.fence?.runId, fence.runId); assert.equal(record.fence?.attempt, 4);
  assert.equal(record.requests.filter(request => request.state === "accepted").length, 4);
});

test("ambiguous normalization effects block without repeating their complete generation or closing instruction", async () => {
  const { repo, fence } = await fixture(); let failures = 0;
  const h = harness(repo, async spec => {
    const task = (spec.input as { task?: Extract<RetryExpertTask, { kind: "turn" }> }).task;
    if (spec.kind === "expert.turn.normalize" && task?.spec.kind === "instruction" && task.spec.counsel === "grok") { failures++; throw new Error("private provider response lost"); }
  });
  assert.deepEqual(await driveRetryWorkflow(fence, h.steps, h.hook), { state: "blocked", reason: "external_effect_uncertain" });
  assert.equal(failures, 1); assert.equal(h.pauses.length, 0);
  assert.ok(!(await repo.readEvents(fence.caseId)).some(event => event.type === "instruction_closed"));
  assert.ok([...h.calls.values()].every(count => count === 1));
});

test("cursor corruption or a missing earlier effect blocks instead of restarting the procedure", async () => {
  const { repo, fence } = await fixture(), h = harness(repo, undefined, true);
  assert.equal((await driveRetryWorkflow(fence, h.steps, h.hook)).state, "finished");
  const record = (await repo.read(fence.caseId))!; record.state = "active";
  record.units = record.units.filter(unit => unit.kind !== "expert.turn.generation");
  assert.equal(nextRetryExpertProcedurePlan(record, auxiliary).state, "blocked");
  const corrupted = (await repo.read(fence.caseId))!; corrupted.state = "active";
  (corrupted.cursor as { configurationHash: string }).configurationHash = "b".repeat(64);
  assert.equal(nextRetryExpertProcedurePlan(corrupted, auxiliary).state, "blocked");
});
