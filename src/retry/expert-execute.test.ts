import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { createMockSeat, createQuickMockModel } from "../court/mock.ts";
import type { Submission } from "../domain/court.ts";
import { continuationHash } from "../domain/continuation.ts";
import { retryCreationHash } from "../domain/retry-contract.ts";
import { CourtActionSchemas } from "../instruction/court-tools.ts";
import { z } from "zod";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { retryExpertFixtureCreation } from "./test-fixture.ts";
import { nextRetryExpertProcedurePlan } from "./expert-procedure.ts";
import { executeRetryExpertUnit, type RetryExpertEffectAdapters } from "./expert-execute.ts";
import { performRetryExpertCourtTool } from "./expert-tool.ts";
import { generateRetryExpertText } from "./expert-turn.ts";

async function fixture() {
  const creation = retryExpertFixtureCreation("expert-dispatch"), repo = new MemoryRetryRepository();
  creation.configuration.tools["expert.intake:judge:decision"] = Object.fromEntries(["enter_claims", "dismiss_case"].map(name => [name, {
    description: name, inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(CourtActionSchemas[name as "enter_claims"], { target: "draft-7" }))),
  }]));
  creation.configurationHash = continuationHash(creation.configuration); creation.creation.snapshotHash = retryCreationHash(creation);
  await repo.create(creation, creation.configuration.submission as Submission);
  const key = creation.initialStart.requestKey, id = creation.creation.caseId;
  await repo.claimStart(id, key); await repo.registerStart(id, key, { runId: "run", deploymentId: "fixture-deployment", world: "fixture" });
  await repo.observeStart(id, key, { state: "returned", runId: "run" });
  const fence = await repo.reconcileStart(id, key); assert.ok(fence);
  return { repo, fence, submission: creation.configuration.submission as Submission };
}

test("new Expert dispatch records every generation/normalization before real local court application", async (t) => {
  const previous = process.env.CONTEXT_SIZE;
  process.env.CONTEXT_SIZE = "12345";
  t.after(() => { if (previous === undefined) delete process.env.CONTEXT_SIZE; else process.env.CONTEXT_SIZE = previous; });
  const limits: number[] = [];
  const { repo, fence, submission } = await fixture(), calls = new Map<string, number>();
  const decision = createMockSeat({ spec: { kind: "intake" }, record: [], submission, native: true }, false).model;
  const check = async (spec: RetryUnitSpec) => {
    const record = (await repo.read(fence.caseId))!, unit = record.units.find(unit => unit.key === spec.key)!;
    assert.equal(unit.state, "running"); assert.equal(unit.inputHash, continuationHash(spec.input)); assert.ok(unit.owner);
    for (const key of unit.dependencies) assert.equal(record.units.find(unit => unit.key === key)?.state, "ready");
    calls.set(spec.key, (calls.get(spec.key) ?? 0) + 1);
  };
  const adapters: RetryExpertEffectAdapters = {
    model(spec) {
      calls.set(spec.key, (calls.get(spec.key) ?? 0) + 1);
      const underlying = (spec.input as { payload: { channel: string } }).payload.channel === "preparation" ? createQuickMockModel("answer") : decision;
      return new MockLanguageModelV4({ doGenerate: async (options) => { limits.push(options.maxOutputTokens!); return underlying.doGenerate(options); } });
    },
    async normalize(spec) { await check(spec); return { body: (spec.input as { payload: { text: string } }).payload.text }; },
    async tool(spec) { await check(spec); return performRetryExpertCourtTool(spec); },
  };
  for (let step = 0; step < 25; step++) {
    const record = (await repo.read(fence.caseId))!, next = nextRetryExpertProcedurePlan(record);
    if ((record.cursor as { stage?: string } | null)?.stage === "instruction") break;
    if (next.state === "boundary") { await repo.publishBoundary(fence, next.boundary); continue; }
    assert.equal(next.state, "units"); if (next.state !== "units") throw new Error("Unexpected plan");
    for (const unit of next.units) {
      const result = await executeRetryExpertUnit(repo, fence, unit, adapters); assert.equal(result.state, "complete");
      const duplicate = await executeRetryExpertUnit(repo, fence, unit); assert.equal(duplicate.state, "complete");
      if (duplicate.state === "complete") assert.equal(duplicate.reused, true);
    }
  }
  const events = await repo.readEvents(fence.caseId);
  assert.equal(events.filter(event => event.type === "claims_entered").length, 1);
  assert.ok([...calls.values()].every(count => count === 1));
  assert.ok(limits.length > 0 && limits.every(limit => limit === 12_345));
  const record = (await repo.read(fence.caseId))!;
  assert.equal(record.units.filter(unit => unit.kind === "expert.turn.normalize").length, 2);
  assert.ok(record.units.some(unit => unit.kind === "expert.turn.tool" && unit.effect === "pure"));
});

test("Expert retry dispatch uses the phase-specific output limit", async (t) => {
  const keys = ["CONTEXT_SIZE", "RESEARCH_CONTEXT_SIZE", "DEBATE_CONTEXT_SIZE"] as const;
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { CONTEXT_SIZE: "10000", RESEARCH_CONTEXT_SIZE: "24000", DEBATE_CONTEXT_SIZE: "8000" });
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  for (const [kind, expected] of [["intake", 10000], ["instruction", 24000], ["source_review", 24000], ["statement", 8000]] as const) {
    const underlying = createQuickMockModel("answer");
    const model = new MockLanguageModelV4({ doGenerate: async options => { assert.equal(options.maxOutputTokens, expected); return underlying.doGenerate(options); } });
    const spec = { kind: "expert.turn.generation", effect: "external", input: { task: { kind: "turn", spec: { kind } }, model: { id: "fixture/model" },
      payload: { system: "Fixture", messages: [{ role: "user", content: "Check" }], mode: "reasoning", tools: {},
        budget: { expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 1, timeoutMs: 10000 }, outputSchema: null } } } as unknown as RetryUnitSpec;
    await generateRetryExpertText(spec, model);
    assert.equal(model.doGenerateCalls.length, 1);
  }
});

test("missing adapters, forged prompts and stale fences cannot dispatch a provider", async () => {
  const { repo, fence } = await fixture(); let calls = 0;
  for (;;) {
    const next = nextRetryExpertProcedurePlan((await repo.read(fence.caseId))!);
    if (next.state === "boundary") { await repo.publishBoundary(fence, next.boundary); continue; }
    assert.equal(next.state, "units"); if (next.state !== "units") throw new Error("Unexpected plan");
    const unit = next.units[0];
    if (unit.kind !== "expert.turn.generation") { assert.equal((await executeRetryExpertUnit(repo, fence, unit)).state, "complete"); continue; }
    const before = await repo.read(fence.caseId);
    assert.equal((await executeRetryExpertUnit(repo, fence, unit)).state, "blocked");
    const forged = structuredClone(unit); (forged.input as { payload: { system: string } }).payload.system = "current settings";
    const adapter = { model() { calls++; return createQuickMockModel("answer"); } };
    assert.equal((await executeRetryExpertUnit(repo, fence, forged, adapter)).state, "blocked");
    assert.equal((await executeRetryExpertUnit(repo, { ...fence, epoch: fence.epoch + 1 }, unit, adapter)).state, "blocked");
    assert.deepEqual(await repo.read(fence.caseId), before); assert.equal(calls, 0); break;
  }
});

async function nextGeneration(repo: MemoryRetryRepository, fence: Awaited<ReturnType<typeof fixture>>["fence"]) {
  for (let step = 0; step < 10; step++) {
    const next = nextRetryExpertProcedurePlan((await repo.read(fence.caseId))!);
    if (next.state === "boundary") { await repo.publishBoundary(fence, next.boundary); continue; }
    assert.equal(next.state, "units"); if (next.state !== "units") throw new Error("Unexpected plan");
    const unit = next.units[0];
    if (unit.kind === "expert.turn.generation") return unit;
    assert.equal((await executeRetryExpertUnit(repo, fence, unit)).state, "complete");
  }
  throw new Error("Generation not reached");
}

test("a lost generation COMMIT response and interrupted dispatch reuse its durable result before any tool", async () => {
  const { repo, fence } = await fixture(), spec = await nextGeneration(repo, fence); let calls = 0;
  const transport = new Proxy(repo, { get(target, property) {
    if (property === "completeUnit") return async (...args: Parameters<RetryRepository["completeUnit"]>) => {
      await target.completeUnit(...args); throw new Error("Synthetic COMMIT response lost");
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const first = await executeRetryExpertUnit(transport, fence, spec, { model() { calls++; return createQuickMockModel("answer"); } });
  assert.equal(first.state, "complete");
  if (first.state === "complete") assert.equal(first.reused, true);
  const before = await repo.read(fence.caseId);
  const restored = await executeRetryExpertUnit(repo, fence, spec);
  assert.equal(restored.state, "complete");
  assert.deepEqual(await repo.read(fence.caseId), before); assert.equal(calls, 1);
  const next = nextRetryExpertProcedurePlan((await repo.read(fence.caseId))!);
  assert.equal(next.state, "units");
  if (next.state === "units") assert.equal(next.units[0].kind, "expert.turn.generation", "only the next decision channel is pending");
});

test("concurrent Expert dispatch cannot take over a running generation or retry an ambiguous provider", async () => {
  const { repo, fence } = await fixture(), spec = await nextGeneration(repo, fence);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0;
  const first = executeRetryExpertUnit(repo, fence, spec, { async model() {
    calls++; entered.resolve(); await release.promise; throw new Error("Private provider response lost");
  } });
  await entered.promise;
  try {
    assert.equal((await executeRetryExpertUnit(repo, fence, spec, { model() { calls++; return createQuickMockModel("answer"); } })).state, "blocked");
  } finally { release.resolve(); }
  assert.deepEqual(await first, { state: "blocked", key: spec.key, reason: "external_effect_uncertain" });
  assert.equal((await executeRetryExpertUnit(repo, fence, spec)).state, "blocked");
  assert.equal(calls, 1);
  assert.equal((await repo.read(fence.caseId))!.units.find(unit => unit.key === spec.key)?.state, "uncertain");
});
