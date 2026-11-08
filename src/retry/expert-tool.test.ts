import assert from "node:assert/strict";
import test from "node:test";
import type { RetryUnitSpec } from "../domain/retry-state.ts";
import { performRetryExpertCourtTool } from "./expert-tool.ts";

function objectionTool(completed: boolean, name = "pass"): RetryUnitSpec {
  return { key: "synthetic-tool", kind: "expert.turn.tool", format: 1, effect: "pure", dependencies: [], estimatedCost: null,
    input: { language: "es", submission: { kind: "text", text: "Synthetic pinned submission", check: "expert" },
      task: { key: "synthetic-turn", kind: "turn", attempt: 0, record: [],
        spec: { kind: "objection", counsel: "gemini", speaker: "grok", statementId: "I1" } },
      payload: { channel: "decision", completed, events: [], call: { name, input: name === "pass" ? {} : { grounds: "Synthetic objection with concrete grounds." } } } } };
}

test("an eventless pass remains complete across separately checkpointed calls", async () => {
  const corpus = { manifest: { schemaVersion: 2 as const, language: "es", documents: [], files: {} }, manifestHash: "a".repeat(64),
    index: "", question: "", documents: new Map() };
  const first = objectionTool(false);
  (first.input as { task: { record: unknown[] } }).task.record = [{ type: "evidence_settled", schemaVersion: 2, manifestHash: corpus.manifestHash }];
  const passed = await performRetryExpertCourtTool(first, corpus) as { done: boolean; events: unknown[] };
  assert.equal(passed.done, true); assert.deepEqual(passed.events, []);
  const later = await performRetryExpertCourtTool(objectionTool(true, "object")) as { done: boolean; events: unknown[]; output: unknown };
  assert.equal(later.done, true); assert.deepEqual(later.events, []);
  assert.deepEqual(later.output, { error: "turn_already_completed" });
});

test("debate tools fail closed without the pinned settled corpus, and preparation cannot apply court actions", async () => {
  await assert.rejects(performRetryExpertCourtTool(objectionTool(false)), /settled corpus unavailable/);
  const preparation = objectionTool(false);
  (preparation.input as { payload: { channel: string } }).payload.channel = "preparation";
  await assert.rejects(performRetryExpertCourtTool(preparation), /action not allowed/);
});
