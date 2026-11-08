import assert from "node:assert/strict";
import test from "node:test";
import { continuationHash } from "../domain/continuation.ts";
import type { RecordedEvent } from "../domain/court.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import { nextRetryQuickPlan } from "./quick.ts";
import { retryFixtureRecord, retryFixtureReply } from "./test-fixture.ts";

function ready(record: RetryRecord, spec: RetryUnitSpec, result: unknown, skipped = false, reason?: string) {
  record.units.push({ ...spec, inputHash: continuationHash(spec.input), state: skipped ? "skipped" : "ready", owner: null,
    attempt: record.fence!.attempt, epoch: record.fence!.epoch,
    ...(skipped ? { reason } : { result, resultHash: continuationHash(result) }) });
}
function run(record: RetryRecord, split = false) {
  const events: RecordedEvent[] = [];
  const calls = new Map<string, number>();
  for (let boundary = 0; boundary < 100; boundary++) {
    const plan = nextRetryQuickPlan(record, { simulation: true });
    assert.notEqual(plan.state, "blocked", JSON.stringify(plan));
    if (plan.state === "finished") return { events, calls };
    if (plan.state === "skip") ready(record, plan.unit, { status: "skipped", reason: plan.reason }, true, plan.reason);
    if (plan.state === "units") for (const spec of plan.units) {
      calls.set(spec.key, (calls.get(spec.key) ?? 0) + 1);
      ready(record, spec, spec.kind === "quick.open" ? { status: "opened" } : retryFixtureReply(spec, split));
    }
    if (plan.state === "boundary") {
      assert.equal(plan.boundary.expectedSeq, events.length + 1);
      events.push(...plan.boundary.events); record.nextSeq += plan.boundary.events.length; record.cursor = plan.boundary.cursor;
    }
    // Simulates reloading after EVERY frontier; no in-memory procedure position.
    Object.assign(record, JSON.parse(JSON.stringify(record)));
  }
  throw new Error("Fixture did not complete");
}

test("new Quick cursor completes claim-free/identified/tied routes with one call per complete unit", () => {
  for (const identify of [false, true]) for (const split of [false, true]) {
    const record = retryFixtureRecord("quick", identify);
    const { events, calls } = run(record, split);
    assert.equal(events[0].type, "session_opened");
    assert.equal(events.at(-1)?.type, "session_closed");
    assert.deepEqual(events.map(e => e.seq), events.map((_e, i) => i + 1));
    assert.equal(events.filter(e => e.type === "quick_response").length, 4);
    assert.equal(events.filter(e => e.type === "content_vote").length, 4);
    assert.equal(events.filter(e => e.type === "vote").length, identify ? 4 : 0);
    assert.equal([...calls.values()].every(count => count === 1), true);
    assert.equal([...calls.keys()].filter(key => key.includes("tiebreak")).length, split ? identify ? 2 : 1 : 0);
    assert.equal(record.units.filter(unit => unit.state === "skipped").length, identify ? 8 : 9);
  }
});

test("a partial answer round retains completed seats without publishing or calling them again", () => {
  const record = retryFixtureRecord();
  let plan = nextRetryQuickPlan(record);
  assert.equal(plan.state, "units"); if (plan.state !== "units") return;
  ready(record, plan.units[0], { status: "opened" });
  plan = nextRetryQuickPlan(record);
  assert.equal(plan.state, "boundary"); if (plan.state !== "boundary") return;
  record.cursor = plan.boundary.cursor; record.nextSeq += plan.boundary.events.length;
  plan = nextRetryQuickPlan(record);
  assert.equal(plan.state, "skip"); if (plan.state !== "skip") return;
  ready(record, plan.unit, { status: "skipped", reason: plan.reason }, true, plan.reason);
  plan = nextRetryQuickPlan(record); assert.equal(plan.state, "boundary"); if (plan.state !== "boundary") return;
  record.cursor = plan.boundary.cursor;
  plan = nextRetryQuickPlan(record); assert.equal(plan.state, "units"); if (plan.state !== "units") return;
  for (const spec of plan.units.slice(1)) ready(record, spec, retryFixtureReply(spec));
  const resumed = nextRetryQuickPlan(record);
  assert.equal(resumed.state, "units");
  if (resumed.state === "units") assert.deepEqual(resumed.units.map(unit => unit.key), ["quick/answer/grok"]);
  assert.equal(record.nextSeq, 2, "No partial answers are published");
});

test("corruption, missing semantic snapshots and unverified post-close artifacts block", () => {
  const record = retryFixtureRecord(); run(record);
  record.cursor = { format: 1, profile: "quick", stage: "turns", target: 0, claims: [] };
  record.units.find(u => u.key === "quick/answer/grok")!.resultHash = "0".repeat(64);
  assert.deepEqual(nextRetryQuickPlan(record), { state: "blocked", reason: "quick_result_unverified" });
  const missing = retryFixtureRecord(); delete missing.contract!.configuration.models["counsel.grok"];
  assert.deepEqual(nextRetryQuickPlan(missing), { state: "blocked", reason: "quick_snapshot_incomplete" });
  const closed = retryFixtureRecord(); run(closed);
  closed.cursor = { format: 1, profile: "quick", stage: "post-close", target: 0, claims: [] };
  assert.deepEqual(nextRetryQuickPlan(closed), { state: "blocked", reason: "quick_artifact_retention_unverified" });
});
