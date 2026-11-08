import assert from "node:assert/strict";
import test from "node:test";
import { caseDate, caseDateRule, formatCaseDate } from "./case-date.ts";
import { composePrompt } from "../court/turns.ts";

test("the case date uses the Argentine civil day and formats it in the case language", () => {
  assert.equal(caseDate("2026-11-08T02:59:59Z"), "2026-11-07");
  assert.equal(caseDate("2026-11-08T03:00:00Z"), "2026-11-08");
  assert.equal(caseDate("2026-11-08"), "2026-11-08");
  assert.equal(formatCaseDate("2026-11-07", "es"), "07 de noviembre de 2026");
  assert.equal(formatCaseDate("2026-11-07", "en"), "November 07, 2026");
  assert.match(caseDateRule("2026-11-07", "en"), /Resolve relative dates.*against this case date/);
});

test("expert prompts anchor relative dates without rewriting the submission", () => {
  const submission = { kind: "text" as const, text: "Today the price fell." };
  for (const seat of ["judge", "grok"] as const) {
    const prompt = composePrompt({ seat, docket: { submission, today: "2026-11-07", caseDate: "2026-11-07", language: "en" }, record: [], instruction: "Check it", attempt: 0 });
    assert.match(prompt, /November 07, 2026/);
    assert.match(prompt, /Resolve relative dates/);
    assert.match(prompt, /Today the price fell/);
    assert.doesNotMatch(prompt, /Today is 2026-11-07/);
  }
});
