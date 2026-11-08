// Installed SDK/World probe ONLY. No application imports, .env loader, providers,
// existing journal, server or database. The parent forks a scrubbed worker.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const file = fileURLToPath(import.meta.url);
const workflowId = "workflow//retry-probe//session";
const unitId = "step//retry-probe//unit";
const markId = "step//retry-probe//mark";

// Minimal fixture bundle, using the installed SDK's VM bindings. This tests
// actual step execution, error capture, journal, createHook and resumeHook, but
// NOT the Next compiler transform, a production workflow or a DB transaction.
const bundle = `
globalThis.__private_workflows ??= new Map();
const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
const unit = useStep(${JSON.stringify(unitId)});
const mark = useStep(${JSON.stringify(markId)});
async function session(token, mode) {
  const completed = await unit("completed");
  try { await unit("recoverable"); }
  catch {
    const hook = createHook({ token });
    try {
      // Minimal bundles may reject instead of returning the conflicting Run
      // handle (no Run serializer is bundled). Either outcome must block.
      try { if (await hook.getConflict()) return "conflict"; }
      catch { return "conflict"; }
      await mark(token, "registered");
      if (mode === "fail") throw new Error("synthetic terminal failure");
      const received = new Set();
      let attempts = 0;
      for await (const command of hook) {
        if (command.requestKey === "finish") return { completed, attempts };
        if (received.has(command.requestKey)) {
          await mark(token, "duplicate");
          continue;
        }
        received.add(command.requestKey);
        attempts++;
        await unit("pending");
        await mark(token, "resumed");
      }
    } finally { hook[Symbol.dispose](); }
  }
}
globalThis.__private_workflows.set(${JSON.stringify(workflowId)}, session);
`;

async function probe(): Promise<Record<string, unknown>> {
  assert.equal(process.env.GROKEADO_RETRY_PROBE, "isolated");
  assert.equal(process.env.WORKFLOW_TARGET_WORLD, "local");
  for (const key of Object.keys(process.env)) assert.ok(!/DATABASE_URL|TOKEN|SECRET|API_KEY|VERCEL_|AWS_|BLOB_|R2_/i.test(key), "Provider/application environment must be absent");
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in isolated retry probe"); };
  Socket.prototype.connect = function () { networkAttempts++; throw new Error("Sockets forbidden in isolated retry probe"); };
  const { createWorld } = await import("@workflow/world-local");
  const { setWorld, workflowEntrypoint } = await import("@workflow/core/runtime");
  const { start, resumeHook } = await import("workflow/api");
  const { getWorkflowMetadata } = await import("workflow");
  const { HookNotFoundError } = await import("workflow/errors");
  const directory = await mkdtemp(join(tmpdir(), "grokeado-retry-hooks-"));
  const world = createWorld({ dataDir: directory, recoverActiveRuns: false });
  const counts = new Map<string, Map<string, number>>();
  const marks = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const marked = (token: string, name: string) => {
    const key = `${token}:${name}`;
    if (!marks.has(key)) marks.set(key, Promise.withResolvers<void>());
    return marks.get(key)!;
  };
  const awaitMark = async (run: { returnValue: Promise<unknown> }, token: string, name: string) => {
    // A failed exposure step must fail the probe, not leave an unresolved
    // promise that lets Node exit without exercising finally/cleanup.
    await Promise.race([
      marked(token, name).promise,
      run.returnValue.then(() => { throw new Error("Fixture run ended before the expected marker"); }),
    ]);
  };
  const unit = Object.assign(async (name: string) => {
    const runId = getWorkflowMetadata().workflowRunId;
    if (!counts.has(runId)) counts.set(runId, new Map());
    const calls = counts.get(runId)!;
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (name === "recoverable") throw new Error("synthetic recoverable failure");
    return `synthetic ${name} result`;
  }, { maxRetries: 0, stepId: unitId });
  const mark = Object.assign(async (token: string, name: string) => {
    if (name === "registered") {
      const hook = await world.hooks.getByToken(token);
      assert.equal(hook.runId, getWorkflowMetadata().workflowRunId);
      const journal = await world.events.list({ runId: hook.runId });
      assert.ok(journal.data.some(event => event.eventType === "hook_created" && event.correlationId === hook.hookId));
    }
    marked(token, name).resolve();
  }, { maxRetries: 0, stepId: markId });
  // Same registration table emitted by the SDK builder, scoped to this child.
  const globals = globalThis as unknown as Record<symbol, Map<string, unknown>>;
  const stepKey = Symbol.for("@workflow/core//registeredSteps");
  globals[stepKey] ??= new Map();
  globals[stepKey].set(unitId, unit);
  globals[stepKey].set(markId, mark);
  const session = Object.assign(async (_token: string, _mode: string) => {}, { workflowId });
  setWorld(world);
  world.registerHandler("__wkf_workflow_", workflowEntrypoint(bundle));
  try {
    await world.start?.();
    const run = await start(session, ["fixture-main", "wait"], { world });
    await awaitMark(run, "fixture-main", "registered");
    assert.equal(await run.status, "running", "Paused case is not a failed SDK run");
    const conflict = await start(session, ["fixture-main", "wait"], { world });
    assert.equal(await conflict.returnValue, "conflict");
    assert.equal((await world.hooks.getByToken("fixture-main")).runId, run.runId);

    // Separate invocations model resending after a lost response. They really
    // append another event, rather than providing cross-call idempotency.
    const command = { requestKey: "fixture-request", version: "same-run-retry/1", expectedAttempt: 0, expectedEpoch: 0 };
    const responses = await Promise.all([
      resumeHook("fixture-main", command), resumeHook("fixture-main", command),
    ]);
    assert.ok(responses.every(response => response.runId === run.runId));
    await awaitMark(run, "fixture-main", "duplicate");
    await awaitMark(run, "fixture-main", "resumed");
    const journal = await world.events.list({ runId: run.runId });
    assert.equal(journal.data.filter(event => event.eventType === "hook_received").length, 2);
    assert.equal(counts.get(run.runId)?.get("completed"), 1);
    assert.equal(counts.get(run.runId)?.get("recoverable"), 1, "Workflow automatic step retries must be zero");
    assert.equal(counts.get(run.runId)?.get("pending"), 1);
    await resumeHook("fixture-main", { requestKey: "finish" });
    assert.deepEqual(await run.returnValue, { completed: "synthetic completed result", attempts: 1 });
    await assert.rejects(resumeHook("fixture-main", command), HookNotFoundError);

    const cancelled = await start(session, ["fixture-cancel", "wait"], { world });
    await awaitMark(cancelled, "fixture-cancel", "registered");
    await cancelled.cancel();
    assert.equal(await cancelled.status, "cancelled");
    await assert.rejects(resumeHook("fixture-cancel", command), HookNotFoundError);

    const failed = await start(session, ["fixture-fail", "fail"], { world });
    await assert.rejects(failed.returnValue);
    assert.equal(await failed.status, "failed");
    await assert.rejects(resumeHook("fixture-fail", command), HookNotFoundError);
    await assert.rejects(resumeHook("fixture-missing", command), HookNotFoundError);
    const stored = await world.runs.get(run.runId, { resolveData: "none" });
    assert.equal(networkAttempts, 0);
    return {
      sameRun: true, completedCalls: 1, pendingCalls: 1, automaticStepRetries: 0,
      duplicateDeliveryEvents: 2, consumerAttempts: 1, registrationConfirmedBeforeExposure: true,
      hookConflictBlocked: true, terminalRunsBlocked: ["completed", "failed", "cancelled"],
      externalProviderCalls: 0, networkAttempts, deploymentId: stored.deploymentId,
      pinnedCodeAvailabilityProved: false, productionRetentionProved: false,
    };
  } finally {
    await world.close?.();
    setWorld(undefined);
    globals[stepKey].delete(unitId); globals[stepKey].delete(markId);
    await rm(directory, { recursive: true, force: true }); // Only our mkdtemp.
  }
}

export async function runLocalRetryHookProbe(): Promise<Record<string, unknown>> {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test", GROKEADO_RETRY_PROBE: "isolated", WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0", WORKFLOW_VM_RETENTION: "0",
  };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return await new Promise((resolve, reject) => {
    const child = fork(file, ["--worker"], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let report: Record<string, unknown> | undefined;
    let error = "";
    child.stderr?.on("data", chunk => { error = (error + chunk.toString()).slice(-3000); });
    child.on("message", message => { report = message as Record<string, unknown>; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated retry hook probe timed out")); }, 45_000);
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0 && report) resolve(report);
      else reject(new Error(`Isolated retry hook probe failed (exit ${code}): ${error}`));
    });
  });
}

if (process.argv[2] === "--worker") {
  assert.ok(process.connected, "Worker requires an isolated parent");
  probe().then(report => { process.send?.(report); process.disconnect?.(); }, error => {
    console.error(error); process.exitCode = 1; process.disconnect?.();
  });
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLocalRetryHookProbe().then(report => console.log(JSON.stringify(report)), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
