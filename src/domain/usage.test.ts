import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, caseUsageArtifact, normalizeUsage, USAGE_ROLES, usageCalls } from "./usage.ts";

const step = (id: string, modelId = "openai/test", role?: string, effort: string | null = "high", usage: unknown = { inputTokens: 100, outputTokens: 20 }) => ({ id, kind: "model_step", modelId, effort, seat: "grok", data: { ...(role ? { role } : {}), usage } });

test("SDK totals and raw Gateway totals include cached input and reasoning output exactly once", () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 100, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 10 }, outputTokenDetails: { reasoningTokens: 15 } }), { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 10 });
  assert.deepEqual(normalizeUsage({ inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 }, outputTokens: { total: 30, text: 15, reasoning: 15 } }), { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 10 });
  assert.equal(normalizeUsage({ inputTokens: { noCache: 70, cacheRead: 20, cacheWrite: 10 } }).inputTokens, 100);
  assert.equal(normalizeUsage({ outputTokens: { text: 15, reasoning: 15 } }).outputTokens, 30);
  assert.deepEqual(normalizeUsage({ inputTokens: -1, outputTokens: Infinity }), { inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("aggregate per provider/model/effort/role, deduplicate checkpointed calls, and preserve unknown effort", () => {
  const records = [step("a"), step("b"), step("a"), step("c", "openai/test", "translator"), step("d", "openai/test", "analyst", null), step("e", "google/test")];
  const calls = usageCalls(records);
  assert.equal(calls.length, 5);
  const totals = aggregateUsage(calls);
  assert.equal(totals.length, 4);
  assert.deepEqual(totals.find((row) => row.provider === "openai" && row.role === "analyst" && row.effort === "high"), { provider: "openai", model: "openai/test", effort: "high", role: "analyst", inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2, unknownUsageCalls: 0 });
  assert.deepEqual(caseUsageArtifact("fixture", records).usage, totals);
  assert.deepEqual(caseUsageArtifact("fixture", [...records].reverse()).usage, totals);
});

test("every requested role is distinct, model prefixes determine provider, and non-usage records are excluded", () => {
  const records = USAGE_ROLES.map((role) => step(role, "spacexai/grok", role));
  records.push({ ...step("moderator-seat"), seat: "judge" });
  const calls = usageCalls([...records, { kind: "source_operation", modelId: "google/test", data: { usage: { inputTokens: 1000 } } }, { type: "statement" }]);
  assert.deepEqual([...new Set(calls.map((call) => call.role))].sort(), [...USAGE_ROLES].sort());
  assert.equal(calls[0]!.provider, "spacexai");
  assert.equal(calls.at(-1)!.role, "moderator");
  assert.equal(calls.length, USAGE_ROLES.length + 1);
});

test("missing image tokens remain unknown while explicit zeros remain zero", () => {
  const totals = aggregateUsage(usageCalls([step("image", "spacexai/image", "imagine", null, {}), step("zero", "test/free", "translator", null, { inputTokens: 0, outputTokens: 0 })]));
  assert.equal(totals.find((row) => row.role === "imagine")!.unknownUsageCalls, 1);
  assert.equal(totals.find((row) => row.role === "imagine")!.inputTokens, null);
  assert.equal(totals.find((row) => row.role === "translator")!.inputTokens, 0);
});

test("the classifier's model steps are counted as the classifier, not as an analyst", () => {
  const step = (id: string, seat: string) => ({ kind: "model_step", id, seat, modelId: "openai/gpt-6.1-terra", effort: "medium", data: { usage: { inputTokens: 10, outputTokens: 2 } } });
  assert.deepEqual(usageCalls([step("a", "classifier"), step("b", "judge"), step("c", "grok")]).map((call) => call.role), ["classifier", "moderator", "analyst"]);
});
