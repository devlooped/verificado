import assert from "node:assert/strict";
import test from "node:test";
import type { Submission } from "../domain/court.ts";
import { reconcileInitialRetryStart } from "./initial-start.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { retryFixtureCreation } from "./test-fixture.ts";

test("initial start is one-shot across response loss and late same-run registration", async () => {
  for (const lost of [false, true]) {
    const repo = new MemoryRetryRepository(); const creation = retryFixtureCreation(); const id = creation.creation.caseId;
    await repo.create(creation, creation.configuration.submission as Submission); let starts = 0;
    const start = async () => { starts++; if (lost) throw new Error("Synthetic lost response"); return { runId: "fixture-original-run" }; };
    assert.equal(await reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, start), null);
    assert.equal(await reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, start), null);
    assert.equal(starts, 1);
    await repo.registerStart(id, creation.initialStart.requestKey, { runId: "fixture-original-run", deploymentId: "fixture-code", world: "fixture" });
    assert.deepEqual(await reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, start), { caseId: id, runId: "fixture-original-run", attempt: 0, epoch: 0 });
    assert.equal(starts, 1);
  }
});

test("concurrent initial starts and a lost observation commit cannot grant another start", async () => {
  const repo = new MemoryRetryRepository(); const creation = retryFixtureCreation(); const id = creation.creation.caseId;
  await repo.create(creation, creation.configuration.submission as Submission); let starts = 0;
  const gate = Promise.withResolvers<void>();
  const start = async () => { starts++; await gate.promise; return { runId: "fixture-original-run" }; };
  const first = reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, start);
  const second = reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, start);
  gate.resolve(); assert.deepEqual(await Promise.all([first, second]), [null, null]); assert.equal(starts, 1);
  const other = new MemoryRetryRepository(); await other.create(creation, creation.configuration.submission as Submission);
  const broken = { claimStart: other.claimStart.bind(other), reconcileStart: other.reconcileStart.bind(other), observeStart: async () => { throw new Error("Synthetic storage response loss"); } };
  await assert.rejects(reconcileInitialRetryStart(broken, id, creation.initialStart.requestKey, start));
  assert.equal(await reconcileInitialRetryStart(other, id, creation.initialStart.requestKey, start), null); assert.equal(starts, 2);
});
