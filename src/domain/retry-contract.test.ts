import assert from "node:assert/strict";
import test from "node:test";
import { continuationHash } from "./continuation.ts";
import {
  parseRetryContract, RETRY_CONTRACT_VERSION, RETRY_ROUTES_ENABLED, retryCommandMatches,
  retryCreationHash, retryPreflight, type RetryBlockReason, type RetryContract, type RetryPreflightInput,
} from "./retry-contract.ts";

function fixture(check: "quick" | "expert" = "quick"): RetryContract {
  const configuration: RetryContract["configuration"] = {
    check, pipelineVersion: 5, submission: { kind: "text", text: "Synthetic material", check },
    models: { judge: { id: "fixture/judge", effort: null, providerOptions: {} } },
    prompts: { judge: "Synthetic prompt v1" }, tools: {}, language: "es", today: "2026-11-07",
    budgets: { decision: { deadline: "2026-11-07T12:01:00.000Z", remaining: 2 } },
    automaticRetries: { workflow: 0, ai: 0, provider: 0, broker: 0, sandbox: 0 },
  };
  const contract: RetryContract = {
    version: RETRY_CONTRACT_VERSION,
    creation: { caseId: "fixture-case", nonce: "fixture-nonce", at: "2026-11-07T12:00:00.000Z", snapshotHash: "0".repeat(64) },
    initialStart: { requestKey: "fixture-start" }, configuration,
    configurationHash: continuationHash(configuration),
    binding: { runId: "fixture-run", deploymentId: "fixture-deployment", world: "fixture" },
  };
  contract.creation.snapshotHash = retryCreationHash(contract);
  return contract;
}
function observations(): RetryPreflightInput {
  return {
    admin: true, caseId: "fixture-case", contract: fixture(), creationRecordedAtomically: true,
    initialStartReconciled: true, caseState: "paused",
    run: { runId: "fixture-run", deploymentId: "fixture-deployment", world: "fixture", status: "running" },
    pause: { runId: "fixture-run", hookId: "fixture-hook", attempt: 0, epoch: 0 },
    hook: { runId: "fixture-run", hookId: "fixture-hook", registrationInJournal: true, active: true },
    deploymentAvailable: true, retentionVerified: true, quotaVerified: true, evidenceVerified: true,
    operations: [],
  };
}

test("new Quick and Expert contracts validate, but neither enables retry", () => {
  assert.equal(RETRY_ROUTES_ENABLED, false);
  for (const check of ["quick", "expert"] as const) {
    assert.deepEqual(parseRetryContract(fixture(check)), fixture(check));
    const result = retryPreflight({ ...observations(), contract: fixture(check) });
    assert.equal(result.eligible, true);
    assert.equal(result.state, "blocked");
    assert.deepEqual(result.reasons, ["route_disabled"]);
  }
});

test("legacy cases, dates, pipeline versions and unknown versions never confer eligibility", () => {
  for (const contract of [null, undefined, {}, { pipelineVersion: 5, createdAt: "2026-11-07" },
    { ...fixture(), version: "same-run-retry/2" }]) {
    assert.equal(retryPreflight({ ...observations(), caseId: "AT-185-GA", contract }).eligible, false);
  }
  assert.deepEqual(retryPreflight({ ...observations(), contract: undefined }).reasons, ["no_creation_contract"]);
  assert.equal(retryPreflight({ ...observations(), creationRecordedAtomically: false }).eligible, false);
  assert.equal(retryPreflight({ ...observations(), caseId: "another-case" }).eligible, false);
});

test("the complete semantic snapshot, not pipeline or model name alone, is fingerprinted", () => {
  for (const mutate of [
    (c: RetryContract) => { c.configuration.prompts.judge = "Different prompt"; },
    (c: RetryContract) => { c.configuration.models.judge = { id: "fixture/judge", effort: "high" }; },
    (c: RetryContract) => { c.configuration.tools.lookup = { version: 2 }; },
    (c: RetryContract) => { c.configuration.language = "en"; },
    (c: RetryContract) => { c.configuration.budgets.decision = { remaining: 100 }; },
    (c: RetryContract) => { c.initialStart.requestKey = "second-start"; },
    (c: RetryContract) => { c.creation.nonce = "late-enrollment"; },
  ]) {
    const contract = fixture(); mutate(contract);
    assert.equal(parseRetryContract(contract), null);
  }
});

test("contracts reject lossy data, executable accessors and automatic retry policies", () => {
  let reads = 0;
  const getter = Object.defineProperty(fixture(), "configuration", { get() { reads++; throw new Error("private"); }, enumerable: true });
  assert.equal(parseRetryContract(getter), null);
  assert.equal(reads, 0);
  for (const value of [undefined, NaN, Array(1), { extra: undefined }]) {
    const contract = fixture(); (contract.configuration.models as Record<string, unknown>).judge = value;
    assert.equal(parseRetryContract(contract), null);
  }
  for (const sdk of ["workflow", "ai", "provider", "broker", "sandbox"] as const) {
    const contract = fixture(); Object.assign(contract.configuration.automaticRetries, { [sdk]: 1 });
    contract.configurationHash = continuationHash(contract.configuration);
    contract.creation.snapshotHash = retryCreationHash(contract);
    assert.equal(parseRetryContract(contract), null);
  }
});

test("preflight distinguishes a paused case from a terminal or inaccessible SDK run", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const input = observations(); input.run!.status = status;
    assert.ok(retryPreflight(input).reasons.includes("run_terminal"));
  }
  for (const caseState of ["active", "pausing", "blocked", "finished"] as const) {
    assert.ok(retryPreflight({ ...observations(), caseState }).reasons.includes("not_paused"));
  }
  assert.ok(retryPreflight({ ...observations(), run: null }).reasons.includes("run_unavailable"));
  const input = observations(); input.run!.status = "pending";
  assert.ok(retryPreflight(input).reasons.includes("run_unavailable"));
});

test("hook registration, matching run/deployment, start reconciliation and retention are independent proofs", () => {
  const failures: [Partial<RetryPreflightInput>, RetryBlockReason][] = [
    [{ hook: null }, "hook_unconfirmed"],
    [{ hook: { runId: "fixture-run", hookId: "fixture-hook", registrationInJournal: false, active: true } }, "hook_unconfirmed"],
    [{ hook: { runId: "another-run", hookId: "fixture-hook", registrationInJournal: true, active: true } }, "hook_mismatch"],
    [{ hook: { runId: "fixture-run", hookId: "stale-hook", registrationInJournal: true, active: true } }, "hook_mismatch"],
    [{ pause: null }, "pause_unverified"],
    [{ pause: { runId: "fixture-run", hookId: "fixture-hook", attempt: 0, epoch: -1 } }, "pause_unverified"],
    [{ run: { runId: "another-run", deploymentId: "fixture-deployment", world: "fixture", status: "running" } }, "run_mismatch"],
    [{ run: { runId: "fixture-run", deploymentId: "new-fix", world: "fixture", status: "running" } }, "run_mismatch"],
    [{ run: { runId: "fixture-run", deploymentId: "fixture-deployment", world: "another-world", status: "running" } }, "run_mismatch"],
    [{ initialStartReconciled: false }, "initial_start_unreconciled"],
    [{ deploymentAvailable: false }, "deployment_unavailable"],
    [{ retentionVerified: false }, "retention_unverified"],
    [{ quotaVerified: false }, "quota_unverified"],
    [{ evidenceVerified: false }, "evidence_unverified"],
  ];
  for (const [change, reason] of failures) assert.ok(retryPreflight({ ...observations(), ...change }).reasons.includes(reason), reason);
});

test("running/uncertain effects are never adopted; failure requires demonstrated inactivity", () => {
  for (const [state, reason] of [["running", "operation_active"], ["uncertain", "operation_uncertain"], ["proven_failed", "failure_unproved"]] as const) {
    const result = retryPreflight({ ...observations(), operations: [{ state, inactivityProved: false, estimatedCost: null }] });
    assert.ok(result.reasons.includes(reason));
    assert.equal(result.estimatedPendingCost, null);
  }
  const result = retryPreflight({ ...observations(), operations: [{ state: "proven_failed", inactivityProved: true, estimatedCost: 0.25 }] });
  assert.deepEqual(result.reasons, ["route_disabled"]);
  assert.equal(result.estimatedPendingCost, 0.25);
});

test("unknown costs are not zero; completed/skipped results are not charged again", () => {
  const input = observations();
  input.operations = [
    { state: "ready", inactivityProved: true, estimatedCost: 999 },
    { state: "skipped", inactivityProved: true, estimatedCost: null },
    { state: "pending", inactivityProved: true, estimatedCost: 0.25 },
  ];
  assert.equal(retryPreflight(input).estimatedPendingCost, 0.25);
  for (const cost of [null, -1, NaN, Infinity]) {
    assert.equal(retryPreflight({ ...input, operations: [{ state: "pending", inactivityProved: true, estimatedCost: cost }] }).estimatedPendingCost, null);
  }
});

test("non-admin preflight does not disclose eligibility, costs, configuration or hook identity", () => {
  assert.deepEqual(retryPreflight({ ...observations(), admin: false }), {
    eligible: false, state: "blocked", reasons: ["not_admin"], estimatedPendingCost: null,
  });
  const output = JSON.stringify(retryPreflight(observations()));
  for (const privateValue of ["Synthetic prompt", "Synthetic material", "fixture-run", "fixture-deployment"]) assert.ok(!output.includes(privateValue));
});

test("resume commands carry only a request key, contract and expected same-run attempt/epoch", () => {
  const fence = { caseId: "fixture-case", runId: "fixture-run", attempt: 2, epoch: 3 };
  const command = { version: RETRY_CONTRACT_VERSION, requestKey: "admin-request", expectedAttempt: 2, expectedEpoch: 3 };
  assert.equal(retryCommandMatches(command, fence), true);
  for (const change of [{ expectedAttempt: 1 }, { expectedEpoch: 2 }, { version: "old" }, { token: "not-authorization" }, { prompt: "private" }]) {
    assert.equal(retryCommandMatches({ ...command, ...change }, fence), false);
  }
  assert.equal(retryCommandMatches(command, { ...fence, epoch: NaN }), false);
  // Matching is only validation: durable request ownership/authorization/CAS
  // still belongs in a future transaction, never in this predicate.
});
