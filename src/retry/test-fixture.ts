// Synthetic, in-memory fixtures. No app import, .env, model SDK or SQL connection.
import { continuationHash } from "../domain/continuation.ts";
import { RETRY_CONTRACT_VERSION, retryCreationHash, type RetryContract, type RetryCreation } from "../domain/retry-contract.ts";
import type { RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import { COUNSEL, type Submission } from "../domain/court.ts";
import { QUICK_POST_UNITS, type RetryQuickRawResult } from "./quick.ts";

export const RETRY_FIXTURE_AT = "2026-11-07T12:00:00.000Z";
export function retryExpertFixtureCreation(id = "expert-procedure"): RetryCreation {
  const creation = retryFixtureCreation(id);
  const config = creation.configuration;
  config.check = "expert";
  config.submission = { kind: "text", text: "Synthetic Expert statement.", check: "expert" };
  config.prompts = {};
  config.tools = {};
  config.budgets = {};
  for (const phase of ["intake", "instruction", "criticism", "debate"]) for (const seat of ["judge", ...COUNSEL]) for (const channel of ["preparation", "decision"]) {
    const key = `${phase}:${seat}:${channel}`;
    config.prompts[`expert.initial.${key}`] = `Original synthetic ${phase} context`;
    config.prompts[`expert.system.${key}`] = `Original synthetic ${seat} ${channel} system`;
    config.tools[`expert.${key}`] = {};
    config.budgets[`expert.${key}`] = { expiresAt: "2040-01-01T00:00:00.000Z", maxCalls: 3, timeoutMs: 1000 };
  }
  for (const kind of ["intake", "instruction", "unification", "source_review", "statement", "objection", "reply", "ruling", "closing", "tiebreak", "content_vote", "content_tiebreak", "summary"]) config.prompts[`expert.task.${kind}`] = `Original synthetic ${kind} task`;
  creation.configurationHash = continuationHash(config);
  creation.creation.snapshotHash = retryCreationHash(creation);
  return creation;
}
export function retryFixtureCreation(id = "retry-fixture", identifyClaims = false): RetryCreation {
  const submission: Submission = { kind: "text", text: "Synthetic statement to test retry safely.", check: "quick", identifyClaims };
  const kinds = ["quick.identify", "quick.answer", "quick.vote", "quick.tiebreak", ...QUICK_POST_UNITS.map(kind => `quick.post.${kind}`)];
  const configuration: RetryCreation["configuration"] = {
    check: "quick", pipelineVersion: 5, submission,
    models: Object.fromEntries(["judge", ...COUNSEL.map(seat => `counsel.${seat}`)].map(role => [role, { id: `fixture/${role}`, effort: null, providerOptions: {} }])),
    prompts: Object.fromEntries(kinds.map(kind => [kind, `Synthetic ${kind} prompt v1`])), tools: {},
    language: "es", today: "2026-11-07", budgets: { decision: { deadline: "2026-11-07T12:05:00.000Z", maxCalls: 20 } },
    automaticRetries: { workflow: 0, ai: 0, provider: 0, broker: 0, sandbox: 0 },
  };
  const creation: RetryCreation = {
    version: RETRY_CONTRACT_VERSION, creation: { caseId: id, nonce: `nonce-${id}`, at: RETRY_FIXTURE_AT, snapshotHash: "0".repeat(64) },
    configuration, configurationHash: continuationHash(configuration), initialStart: { requestKey: `start-${id}` },
  };
  creation.creation.snapshotHash = retryCreationHash(creation);
  return creation;
}
export function retryFixtureRecord(id = "retry-fixture", identifyClaims = false): RetryRecord {
  const creation = retryFixtureCreation(id, identifyClaims);
  const binding: RetryContract["binding"] = { runId: `run-${id}`, deploymentId: "fixture-deployment", world: "fixture" };
  return {
    creation, contract: { ...creation, binding }, state: "active", fence: { caseId: id, runId: binding.runId, attempt: 0, epoch: 0 },
    startCandidate: binding, startObservation: { state: "returned", runId: binding.runId }, startClaimed: true,
    nextSeq: 1, cursor: null, pause: null, units: [], requests: [],
  };
}
export function retryFixtureReply(spec: RetryUnitSpec, split = false): RetryQuickRawResult {
  const input = spec.input as { model: { id: string } };
  return {
    at: RETRY_FIXTURE_AT, text: `Synthetic answer by ${input.model.id}`, messages: [], usage: { tokens: 10 }, toolResults: [], sources: [], finishReason: "stop",
    output: spec.kind === "quick.identify" ? { claims: [{ quote: "Synthetic statement", text: "A synthetic factual statement for the fixture." }] } :
      spec.kind === "quick.tiebreak" ? { verdict: "falso", reasoning: "Synthetic moderator resolves the tied fixture votes." } :
      spec.kind === "quick.vote" ? { verdict: split && /grok|gemini/.test(input.model.id) ? "verdadero" : "falso", rationale: "Synthetic complete rationale for the fixture vote." } : null,
  };
}
