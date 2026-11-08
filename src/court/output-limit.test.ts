import assert from "node:assert/strict";
import { test } from "node:test";
import { courtMaxOutputTokens, courtOutputPhase } from "./models.ts";

test("phase limits fall back to CONTEXT_SIZE, then 32000", () => {
  for (const phase of [undefined, "research", "debate"] as const) {
    assert.equal(courtMaxOutputTokens(phase, {}), 32_000);
    assert.equal(courtMaxOutputTokens(phase, { CONTEXT_SIZE: "12345" }), 12_345);
    assert.equal(courtMaxOutputTokens(phase, { CONTEXT_SIZE: "" }), 32_000);
  }
  const env = { CONTEXT_SIZE: "12000", RESEARCH_CONTEXT_SIZE: "48000", DEBATE_CONTEXT_SIZE: "16000" };
  assert.equal(courtMaxOutputTokens("research", env), 48_000);
  assert.equal(courtMaxOutputTokens("debate", env), 16_000);
  assert.equal(courtMaxOutputTokens(undefined, env), 12_000);
  assert.equal(courtMaxOutputTokens("research", { ...env, RESEARCH_CONTEXT_SIZE: "" }), 12_000);
  assert.equal(courtMaxOutputTokens("debate", { ...env, DEBATE_CONTEXT_SIZE: "" }), 12_000);
  for (const [phase, key] of [[undefined, "CONTEXT_SIZE"], ["research", "RESEARCH_CONTEXT_SIZE"], ["debate", "DEBATE_CONTEXT_SIZE"]] as const) {
    for (const value of ["0", "-1", "1.5", "1e3", " 500", "nope", "9007199254740992"]) {
      assert.throws(() => courtMaxOutputTokens(phase, { [key]: value }), new RegExp(`${key} must be a positive integer`));
    }
  }
  assert.equal(courtMaxOutputTokens("research", { CONTEXT_SIZE: "invalid", RESEARCH_CONTEXT_SIZE: "1000" }), 1000);
});

test("court phases select the appropriate output limit", () => {
  assert.equal(courtOutputPhase("intake"), undefined);
  assert.equal(courtOutputPhase("instruction"), "research");
  assert.equal(courtOutputPhase("criticism"), "research");
  assert.equal(courtOutputPhase("debate"), "debate");
});
