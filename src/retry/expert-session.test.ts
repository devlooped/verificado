import assert from "node:assert/strict";
import test from "node:test";
import { continuationHash } from "../domain/continuation.ts";
import { retryCreationHash } from "../domain/retry-contract.ts";
import type { RecordedEvent, Submission } from "../domain/court.ts";
import { RetryExpertSession } from "./expert-session.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { retryExpertFixtureCreation } from "./test-fixture.ts";

async function fixture() {
  const creation = retryExpertFixtureCreation("expert-pins"), repo = new MemoryRetryRepository();
  await repo.create(creation, creation.configuration.submission as Submission);
  await repo.claimStart("expert-pins", creation.initialStart.requestKey);
  await repo.registerStart("expert-pins", creation.initialStart.requestKey, { runId: "run", deploymentId: "fixture-deployment", world: "fixture" });
  await repo.observeStart("expert-pins", creation.initialStart.requestKey, { state: "returned", runId: "run" });
  const fence = await repo.reconcileStart("expert-pins", creation.initialStart.requestKey); assert.ok(fence);
  return { repo, fence };
}
const identity = { phase: "instruction", seat: "grok", channel: "decision" } as const;
const record: RecordedEvent[] = [{ type: "instruction_opened", seq: 1, at: "2026-11-07T12:00:00.000Z" }];

test("new Expert restores the creation-time prompt, without accepting current inputs", async () => {
  const { repo, fence } = await fixture();
  const first = await RetryExpertSession.open(repo, fence, identity);
  assert.equal(first.session.state.messages[0].content, "Original synthetic instruction context");
  await first.begin("turn", record, "original task", 12345);
  await first.session.finish();
  const reopened = await RetryExpertSession.open(repo, fence, identity);
  const before = await repo.read(fence.caseId);
  const reused = await reopened.begin("turn", record, "original task", 12345);
  assert.equal(reused.complete, true);
  assert.equal(reused.expiresAt, first.session.state.turns.turn.expiresAt);
  assert.deepEqual(await repo.read(fence.caseId), before, "reuse makes no new checkpoint or effect");
});

test("reused partial and completed turns reject changed task, record prose and budget before mutation", async () => {
  for (const complete of [false, true]) {
    const { repo, fence } = await fixture();
    const opened = await RetryExpertSession.open(repo, fence, identity);
    await opened.begin("turn", record, "original task", 12345);
    if (complete) await opened.session.finish();
    const resumed = await RetryExpertSession.open(repo, fence, identity), before = await repo.read(fence.caseId);
    await assert.rejects(resumed.begin("turn", record, "other task", 12345));
    await assert.rejects(resumed.begin("turn", [{ ...record[0], at: "2026-11-07T13:00:00.000Z" }], "original task", 12345));
    await assert.rejects(resumed.begin("turn", record, "original task", 12346));
    assert.deepEqual(await repo.read(fence.caseId), before);
    assert.equal(resumed.session.state.turns.turn.expiresAt, opened.session.state.turns.turn.expiresAt);
  }
});

test("a rewritten creation snapshot cannot replace the prompt of an existing conversation", async () => {
  const { repo, fence } = await fixture();
  await RetryExpertSession.open(repo, fence, identity);
  const corrupt = new Proxy(repo, { get(target, property) {
    if (property === "read") return async (id: string) => {
      const record = await target.read(id);
      if (record?.contract) {
        record.contract.configuration.prompts["expert.initial.instruction:grok:decision"] = "replacement";
        record.contract.configurationHash = continuationHash(record.contract.configuration);
        record.contract.creation.snapshotHash = retryCreationHash(record.contract);
      }
      return record;
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(RetryExpertSession.open(corrupt, fence, identity));
});
