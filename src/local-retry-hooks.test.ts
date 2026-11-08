import assert from "node:assert/strict";
import test from "node:test";
import { runLocalRetryHookProbe } from "../scripts/test-local-retry-hooks.ts";

test("installed Workflow SDK pauses and deduplicates a same-run hook, with no providers or app store", { timeout: 50_000 }, async () => {
  const report = await runLocalRetryHookProbe();
  assert.equal(report.sameRun, true);
  assert.equal(report.registrationConfirmedBeforeExposure, true);
  assert.equal(report.completedCalls, 1);
  assert.equal(report.pendingCalls, 1);
  assert.equal(report.automaticStepRetries, 0);
  assert.equal(report.duplicateDeliveryEvents, 2);
  assert.equal(report.consumerAttempts, 1);
  assert.equal(report.hookConflictBlocked, true);
  assert.deepEqual(report.terminalRunsBlocked, ["completed", "failed", "cancelled"]);
  assert.equal(report.externalProviderCalls, 0);
  assert.equal(report.networkAttempts, 0);
  assert.equal(report.pinnedCodeAvailabilityProved, false);
  assert.equal(report.productionRetentionProved, false);
});
