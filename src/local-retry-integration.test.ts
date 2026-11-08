import assert from "node:assert/strict";
import test from "node:test";
import { runLocalRetryIntegrationProbe } from "../scripts/test-local-retry-integration.ts";

test("installed SDK executes shared Quick cursor, durable requests and real hook observations on the original run", { timeout: 50_000 }, async () => {
  const report = await runLocalRetryIntegrationProbe();
  for (const key of ["sameRun", "completedEffectsCalledOnce", "lostInitialStartDidNotRestart", "lostResumeDidNotRedispatch", "responseLossBlocked", "registrationConfirmedBeforeExposure"]) assert.equal(report[key], true, key);
  assert.equal(report.separateAuthorizations, 2); assert.equal(report.receivedEvents, 3);
  assert.equal(report.automaticStepRetries, 0); assert.equal(report.networkAttempts, 0); assert.equal(report.realProviderCalls, 0);
  assert.equal(report.productionRetentionProved, false); assert.equal(report.deployedCompilerIntegrationProved, false);
});
