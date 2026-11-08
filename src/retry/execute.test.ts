import assert from "node:assert/strict";
import test from "node:test";
import { continuationHash } from "../domain/continuation.ts";
import type { RetryRecord, RetryRepository, RetryUnit, RetryUnitSpec } from "../domain/retry-state.ts";
import { executeRecordedUnit, executeRetryRound, RetryBeforeEffectFailure } from "./execute.ts";

const fence = { caseId: "fixture", runId: "same-run", attempt: 0, epoch: 0 };
const spec: RetryUnitSpec = { key: "answer:grok", kind: "model", format: 1, dependencies: [], input: { prompt: "Synthetic", model: "fixture" }, effect: "external", estimatedCost: null };
function fixture() {
  let stored: RetryUnit | undefined;
  let completion: "ok" | "lost-after" | "lost-before" = "ok";
  const failures: unknown[] = [];
  const repository: Pick<RetryRepository, "claimUnit" | "completeUnit" | "failUnit" | "read"> = {
    async claimUnit(_fence, unit) {
      if (stored?.state === "ready") return { state: "reused", unit: stored };
      if (stored) return { state: "blocked", reason: stored.state };
      stored = { ...unit, inputHash: continuationHash(unit.input), state: "running", owner: "owner", attempt: 0, epoch: 0 };
      return { state: "claimed", owner: "owner", unit: stored };
    },
    async completeUnit(_fence, _key, _owner, result) {
      if (completion === "lost-before") throw new Error("Synthetic response loss");
      stored = { ...stored!, state: "ready", result, resultHash: continuationHash(result) };
      if (completion === "lost-after") throw new Error("Synthetic COMMIT response loss");
    },
    async failUnit(_fence, _key, _owner, failure) {
      failures.push(failure); stored = { ...stored!, ...failure };
    },
    async read() { return { fence, units: stored ? [stored] : [] } as RetryRecord; },
  };
  return { repository, failures, completion: (value: typeof completion) => { completion = value; }, stored: () => stored };
}

test("an intent precedes the subeffect; an exact complete result is reused without a second call", async () => {
  const f = fixture(); let calls = 0;
  const perform = async () => { assert.equal(f.stored()?.state, "running"); calls++; return { raw: "complete response", messages: [], usage: { tokens: 10 } }; };
  assert.equal((await executeRecordedUnit(f.repository, fence, spec, perform)).state, "complete");
  assert.deepEqual(await executeRecordedUnit(f.repository, fence, spec, perform), { state: "complete", key: spec.key, result: { raw: "complete response", messages: [], usage: { tokens: 10 } }, reused: true });
  assert.equal(calls, 1);
});

test("timeout, cancellation and generic provider exceptions never prove failure/inactivity", async () => {
  for (const error of [new Error("timeout"), new DOMException("cancelled", "AbortError"), new Error("response lost")]) {
    const f = fixture(); let calls = 0;
    const perform = async () => { calls++; throw error; };
    assert.equal((await executeRecordedUnit(f.repository, fence, spec, perform)).state, "blocked");
    assert.equal(f.stored()?.state, "uncertain");
    assert.equal(f.stored()?.inactivityProof, undefined);
    await executeRecordedUnit(f.repository, fence, spec, perform);
    assert.equal(calls, 1);
  }
});

test("only a demonstrated pre-dispatch failure offers pause, without logging the private exception", async () => {
  const f = fixture();
  const result = await executeRecordedUnit(f.repository, fence, spec, async () => { throw new RetryBeforeEffectFailure("fixture_unavailable"); });
  assert.equal(result.state, "paused");
  assert.equal(f.stored()?.state, "proven_failed");
  assert.equal(f.stored()?.inactivityProof, `not-dispatched:${continuationHash(spec.input)}`);
  assert.throws(() => new RetryBeforeEffectFailure("private prompt or token"));
});

test("a committed result with lost completion response reconciles, never repeats the subeffect", async () => {
  const f = fixture(); f.completion("lost-after"); let calls = 0;
  const result = await executeRecordedUnit(f.repository, fence, spec, async () => { calls++; return { raw: "complete" }; });
  assert.deepEqual(result, { state: "complete", key: spec.key, result: { raw: "complete" }, reused: true });
  assert.equal(calls, 1); assert.equal(f.failures.length, 0);
});

test("lost result publication without exact evidence blocks; undefined output cannot become ready", async () => {
  const f = fixture(); f.completion("lost-before"); let calls = 0;
  const perform = async () => { calls++; return { raw: "complete" }; };
  assert.equal((await executeRecordedUnit(f.repository, fence, spec, perform)).state, "blocked");
  await executeRecordedUnit(f.repository, fence, spec, perform);
  assert.equal(calls, 1);
  const empty = fixture();
  assert.equal((await executeRecordedUnit(empty.repository, fence, spec, async () => undefined)).state, "blocked");
  assert.equal(empty.stored()?.state, "uncertain");
});

test("a failed sibling waits for all completed seats before pausing a partial round", async () => {
  const gate = Promise.withResolvers<void>(); let completed = false; let settled = false;
  const round = executeRetryRound([
    async () => ({ state: "paused", key: "grok", reason: "fixture_unavailable" }),
    async () => { await gate.promise; completed = true; return { state: "complete", key: "gemini", result: { raw: "complete" }, reused: false }; },
  ]).then(result => { settled = true; return result; });
  await Promise.resolve(); assert.equal(settled, false);
  gate.resolve(); const results = await round;
  assert.equal(completed, true); assert.deepEqual(results.map(result => result.state), ["paused", "complete"]);
});
