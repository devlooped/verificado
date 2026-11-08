// Installed SDK + application retry protocol ONLY, with a private memory store
// and journal. Not the Next compiler, real providers, PostgreSQL or retention.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RetryFence } from "../src/domain/retry-contract.ts";
import type { RetryPause } from "../src/domain/retry-state.ts";
import { dispatchReservedRetry } from "../src/retry/controller.ts";
import { executeRecordedUnit, RetryBeforeEffectFailure } from "../src/retry/execute.ts";
import { confirmRegisteredRetryPause } from "../src/retry/hook-registration.ts";
import { reconcileInitialRetryStart } from "../src/retry/initial-start.ts";
import { MemoryRetryRepository } from "../src/retry/memory-repository.ts";
import { nextRetryQuickPlan, performPureRetryQuickUnit } from "../src/retry/quick.ts";
import { retryFixtureCreation, retryFixtureReply } from "../src/retry/test-fixture.ts";
import { driveRetryWorkflow, type RetryWorkflowSteps } from "../src/retry/workflow-driver.ts";

const file = fileURLToPath(import.meta.url), workflowId = "workflow//retry-integration//session";
const names = ["initialize", "load", "execute", "skip", "publish", "pause", "confirm", "consume", "block", "finish"] as const;
const ids = Object.fromEntries(names.map(name => [name, "step//retry-integration//" + name]));
// Trusted local function source, not run input. The minimal probe bundle tests
// the shared engine in the installed VM; deployed compiler integration is separate.
const bundle = `
globalThis.__private_workflows ??= new Map();
const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
const steps = Object.fromEntries(Object.entries(${JSON.stringify(ids)}).map(([name, id]) => [name, useStep(id)]));
// tsx preserves function names with this helper in the trusted function source.
const __name = (value, name) => Object.defineProperty(value, "name", { value: name, configurable: true });
const drive = ${driveRetryWorkflow.toString()};
async function session(id) {
  const fence = await steps.initialize(id);
  return await drive(fence, steps, token => createHook({ token }));
}
globalThis.__private_workflows.set(${JSON.stringify(workflowId)}, session);
`;

async function probe(): Promise<Record<string, unknown>> {
  assert.equal(process.env.GROKEADO_RETRY_INTEGRATION, "isolated");
  assert.equal(process.env.WORKFLOW_TARGET_WORLD, "local");
  for (const key of Object.keys(process.env)) assert.ok(!/DATABASE_URL|TOKEN|SECRET|API_KEY|VERCEL_|AWS_|BLOB_|R2_/i.test(key));
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Fixture network forbidden"); };
  Socket.prototype.connect = function () { networkAttempts++; throw new Error("Fixture sockets forbidden"); };
  const { createWorld } = await import("@workflow/world-local");
  const { setWorld, workflowEntrypoint } = await import("@workflow/core/runtime");
  const { start, resumeHook } = await import("workflow/api");
  const { getWorkflowMetadata } = await import("workflow");
  const directory = await mkdtemp(join(tmpdir(), "grokeado-retry-integration-"));
  const world = createWorld({ dataDir: directory, recoverActiveRuns: false }), repo = new MemoryRetryRepository();
  const observed = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const pauses = new Map<string, ReturnType<typeof Promise.withResolvers<{ fence: RetryFence; pause: RetryPause }>>>();
  const calls = new Map<string, number>(), validations = new Map<string, number>(), losses = new Set<string>();
  const firstDelivery = Promise.withResolvers<void>();
  const pauseSignal = (id: string, attempt: number) => {
    const key = `${id}:${attempt}`;
    if (!pauses.has(key)) pauses.set(key, Promise.withResolvers());
    return pauses.get(key)!;
  };
  const implementations: RetryWorkflowSteps & { initialize(id: string): Promise<RetryFence> } = {
    async initialize(id) {
      const record = await repo.read(id); assert.ok(record);
      const runId = getWorkflowMetadata().workflowRunId, run = await world.runs.get(runId, { resolveData: "none" });
      await repo.registerStart(id, record.creation.initialStart.requestKey, { runId, deploymentId: run.deploymentId, world: "local" });
      await observed.get(id)!.promise;
      const fence = await repo.reconcileStart(id, record.creation.initialStart.requestKey); assert.ok(fence); return fence;
    },
    async load(fence) { const record = await repo.read(fence.caseId); assert.ok(record); return nextRetryQuickPlan(record, { simulation: true }); },
    execute: (fence, unit) => executeRecordedUnit(repo, fence, unit, async () => {
      const key = `${fence.caseId}:${unit.key}`, count = (validations.get(key) ?? 0) + 1; validations.set(key, count);
      if (!losses.has(fence.caseId) && ["quick/answer/grok", "quick/answer/claude"].includes(unit.key) && count === 1) throw new RetryBeforeEffectFailure("fixture_unavailable");
      if (unit.effect === "pure") return performPureRetryQuickUnit(unit);
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (losses.has(fence.caseId) && unit.kind === "quick.answer") throw new Error("Synthetic response loss after dispatch");
      return retryFixtureReply(unit, true);
    }),
    skip: (fence, unit, reason) => repo.skipUnit(fence, unit, reason),
    publish: (fence, boundary) => repo.publishBoundary(fence, boundary),
    pause: (fence, key, reason) => repo.beginPause(fence, key, reason),
    async confirm(fence, pause) {
      await confirmRegisteredRetryPause(repo, fence, pause.id, "local", world);
      const record = await repo.read(fence.caseId); assert.equal(record?.state, "paused");
      assert.equal(record.units.some(unit => unit.state === "running"), false);
      pauseSignal(fence.caseId, fence.attempt).resolve({ fence, pause });
    },
    async consume(fence, command) {
      // Deterministic duplicate delivery before the first hook is disposed.
      if (fence.caseId === "fixture-sdk-quick" && fence.attempt === 0) await firstDelivery.promise;
      return repo.consumeRequest(fence, command);
    },
    block: (fence, reason) => repo.block(fence, reason), finish: fence => repo.finish(fence),
  };
  const globals = globalThis as unknown as Record<symbol, Map<string, unknown>>, stepKey = Symbol.for("@workflow/core//registeredSteps");
  globals[stepKey] ??= new Map();
  for (const name of names) globals[stepKey].set(ids[name], Object.assign(implementations[name], { maxRetries: 0, stepId: ids[name] }));
  const session = Object.assign(async (_id: string) => {}, { workflowId });
  setWorld(world); world.registerHandler("__wkf_workflow_", workflowEntrypoint(bundle));
  try {
    await world.start?.();
    const create = async (id: string, loseResponse = false) => {
      const creation = retryFixtureCreation(id, true);
      await repo.create(creation, creation.configuration.submission as Parameters<typeof repo.create>[1]);
      observed.set(id, Promise.withResolvers<void>());
      let run: Awaited<ReturnType<typeof start<void>>> | undefined;
      let starts = 0;
      await reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, async () => {
        starts++; run = await start(session, [id], { world });
        if (loseResponse) throw new Error("Synthetic lost initial-start response");
        return { runId: run.runId };
      });
      observed.get(id)!.resolve(); assert.ok(run);
      await reconcileInitialRetryStart(repo, id, creation.initialStart.requestKey, async () => { starts++; throw new Error("Forbidden second start"); });
      assert.equal(starts, 1); return run;
    };
    const run = await create("fixture-sdk-quick", true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { fence, pause } = await Promise.race([pauseSignal("fixture-sdk-quick", attempt).promise,
        run.returnValue.then(() => { throw new Error("Fixture ended before pause"); })]);
      assert.equal(await run.status, "running"); assert.equal(fence.runId, run.runId);
      const request = await repo.reserveRequest(fence, pause.id, `fixture-admin-${attempt}`, "fixture-admin");
      let sends = 0;
      const dispatch = () => dispatchReservedRetry(repo, fence, request, async (token, command) => {
        sends++; const response = await resumeHook(token, command);
        if (attempt === 0) throw new Error("Synthetic lost resume response");
        return response;
      });
      await Promise.all([dispatch(), dispatch()]); assert.equal(sends, 1);
      // An independent duplicate event tests the durable CONSUMER, not a sender
      // redispatch policy: the normal controller never resends ambiguity.
      if (attempt === 0) { await resumeHook(pause.token, request.command); firstDelivery.resolve(); }
    }
    const result = await run.returnValue;
    assert.deepEqual(result, { state: "finished", fence: { caseId: "fixture-sdk-quick", runId: run.runId, attempt: 2, epoch: 2 } });
    const record = await repo.read("fixture-sdk-quick"); assert.ok(record);
    assert.equal(record.requests.filter(request => request.state === "accepted").length, 2);
    assert.ok([...calls.entries()].filter(([key]) => key.startsWith("fixture-sdk-quick:")).every(([, count]) => count === 1));
    const journal = await world.events.list({ runId: run.runId });
    assert.equal(journal.data.filter(event => event.eventType === "hook_received").length, 3);
    assert.equal((await repo.readEvents("fixture-sdk-quick")).length, record.nextSeq - 1);
    losses.add("fixture-sdk-loss");
    const lost = await create("fixture-sdk-loss");
    assert.deepEqual(await lost.returnValue, { state: "blocked", reason: "external_effect_uncertain" });
    const blocked = await repo.read("fixture-sdk-loss"); assert.equal(blocked?.state, "blocked"); assert.equal(blocked?.pause, null);
    assert.ok(blocked?.units.some(unit => unit.state === "uncertain"));
    assert.equal(networkAttempts, 0);
    return { sameRun: true, separateAuthorizations: 2, completedEffectsCalledOnce: true, receivedEvents: 3,
      lostInitialStartDidNotRestart: true, lostResumeDidNotRedispatch: true, responseLossBlocked: true,
      registrationConfirmedBeforeExposure: true, automaticStepRetries: 0, networkAttempts,
      realProviderCalls: 0, productionRetentionProved: false, deployedCompilerIntegrationProved: false };
  } finally {
    await world.close?.(); setWorld(undefined);
    for (const name of names) globals[stepKey].delete(ids[name]);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function runLocalRetryIntegrationProbe(): Promise<Record<string, unknown>> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", GROKEADO_RETRY_INTEGRATION: "isolated", WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0", WORKFLOW_VM_RETENTION: "0" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = fork(file, ["--worker"], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let report: Record<string, unknown> | undefined, error = "";
    child.stderr?.on("data", chunk => { error = (error + chunk.toString()).slice(-3000); });
    child.on("message", message => { report = message as Record<string, unknown>; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated retry integration timed out")); }, 45_000);
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.on("exit", code => { clearTimeout(timer); code === 0 && report ? resolve(report) : reject(new Error(`Isolated retry integration failed (exit ${code}): ${error}`)); });
  });
}
if (process.argv[2] === "--worker") {
  assert.ok(process.connected, "Worker requires isolated parent");
  probe().then(report => { process.send?.(report); process.disconnect?.(); }, error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLocalRetryIntegrationProbe().then(report => console.log(JSON.stringify(report)), error => { console.error(error.message); process.exitCode = 1; });
}
