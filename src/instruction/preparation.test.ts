import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { FatalError } from "workflow";
import { MemoryPhaseRepository, PhaseSession } from "../court/phase-session.ts";
import { advancePreparation, deleteCaseSandboxes, NATIVE_CALL_MARGIN_MS, nativePreparationDefinitions, PREPARATION_SNAPSHOTS, PREPARATION_SYNTHESIS_MS, prepareInSandbox, SandboxCleanupBlockedError, sweepCaseSandboxes, withSandboxCleanup } from "./preparation.ts";

test("preparation requires a final response, preserves checkpoints on exhaustion, and resumes the same sandbox", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "CONTEXT_SIZE", "RESEARCH_CONTEXT_SIZE", "DEBATE_CONTEXT_SIZE"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    process.env.CONTEXT_SIZE = "32000";
    process.env.RESEARCH_CONTEXT_SIZE = "32000";
    process.env.DEBATE_CONTEXT_SIZE = "8000";
    let runs = 0, stops = 0, creates = 0, resumes = 0, harnessUploads = 0, exitCode = 0;
    let response = { messages: [{ role: "assistant", content: "Still working" }], text: "unfinished draft", finishReason: "tool-calls" };
    const tasks: Array<{ callId: string; toolChoice: string; timeoutMs: number; maxOutputTokens: number | null }> = [];
    let synthesize = false, interruptRead = false;
    let resumeRequested = false;
    const sandbox = {
      name: "persistent-fixture", writeFiles: async (files: { path: string; content: string }[]) => {
        const task = files.find((file) => file.path === "/workspace/task.json");
        if (task) tasks.push(JSON.parse(task.content));
        if (files.some((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")) {
          harnessUploads++;
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")?.content.includes("createGateway"));
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/compute.ts")?.content.includes("export"));
        }
      },
      runCommand: async (command: { cmd: string; detached?: boolean }) => {
        if (resumeRequested) { resumes++; resumeRequested = false; }
        if (command.cmd !== "node") return { exitCode: 0 };
        assert.equal(command.detached, true, "a model call never holds the step that starts it");
        runs++;
        return { cmdId: `call-${runs}`, wait: async () => ({ exitCode }) };
      },
      // A stopped VM loses the call it was running.
      getCommand: async () => { throw new Error("Command not found"); },
      readFileToBuffer: async () => {
        if (interruptRead) { interruptRead = false; throw new Error("Interrupted before message checkpoint"); }
        return Buffer.from(JSON.stringify(synthesize && tasks.at(-1)?.toolChoice === "none"
          ? { messages: [{ role: "assistant", content: "Final analysis" }], text: "Final analysis", finishReason: "stop" }
          : response));
      },
      update: async (policy: typeof PREPARATION_SNAPSHOTS) => { assert.deepEqual(policy, PREPARATION_SNAPSHOTS); },
      stop: async () => { stops++; resumeRequested = false; },
    };
    const deps = {
      sandbox: {
        create: async (input: { timeout: number; persistent: boolean; snapshotExpiration: number; keepLastSnapshots: unknown }) => {
          assert.equal(input.timeout, 300_000);
          assert.equal(input.persistent, true);
          assert.equal(input.snapshotExpiration, 0, "future snapshots must not expire automatically");
          assert.deepEqual(input.keepLastSnapshots, { count: 1, expiration: 0, deleteEvicted: false }, "older referenced snapshots are not deleted on eviction");
          creates++; resumeRequested = false; return sandbox;
        },
        get: async (input: { name: string; resume?: boolean }) => { assert.equal(input.name, sandbox.name); assert.equal(input.resume, false); resumeRequested = true; return sandbox; },
      } as unknown as typeof Sandbox,
      bind: async (_caseId: string, name: string) => { assert.equal(name, sandbox.name); },
    };
    const repository = new MemoryPhaseRepository();
    const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Canonical material" };
    let session = await PhaseSession.open("fixture", initial, repository);
    await session.begin("exhausted-turn", [], "Prepare");
    await assert.rejects(prepareInSandbox(session, deps), (error) => FatalError.is(error) && /budget exhausted without a final response/.test(error.message));
    assert.equal(runs, 8);
    assert.ok(tasks.every((task) => task.maxOutputTokens === 32_000));
    assert.equal(session.state.turns["exhausted-turn"].complete, false);
    assert.equal(session.state.turns["exhausted-turn"].done, false);
    assert.equal(session.state.activeTurn, undefined, "failed preparation suspends its action grant");
    const prefix = JSON.stringify(session.state.messages);
    session = await PhaseSession.open("fixture", initial, repository);
    await session.begin("exhausted-turn", [], "Prepare");
    await assert.rejects(prepareInSandbox(session, deps), /budget exhausted/);
    assert.equal(runs, 8, "retry must not repeat exhausted model steps");
    assert.equal(JSON.stringify(session.state.messages), prefix);
    assert.equal(creates, 1);
    assert.equal(resumes, 0, "an exhausted retry does not resume the VM");
    assert.equal(stops, 1);
    assert.equal(harnessUploads, 1, "new sandboxes get the deployed harness; resumes retain it");

    synthesize = true;
    const synthesizing = await PhaseSession.open("fixture-synthesis", initial, repository);
    await synthesizing.begin("turn", [], "Prepare");
    const first = tasks.length;
    assert.equal(await prepareInSandbox(synthesizing, deps), "Final analysis");
    assert.deepEqual(tasks.slice(first).map((task) => task.toolChoice), [...Array(7).fill("auto"), "none"]);
    assert.equal(synthesizing.state.turns.turn.steps, 8, "synthesis stays within the existing step budget");
    assert.equal(synthesizing.state.turns.turn.complete, true);

    let interrupted = await PhaseSession.open("fixture-interrupted", initial, repository);
    await interrupted.begin("turn", [], "Prepare");
    const beforeInterruption = tasks.length;
    interruptRead = true;
    await assert.rejects(prepareInSandbox(interrupted, deps), /Interrupted before message checkpoint/);
    interrupted = await PhaseSession.open("fixture-interrupted", initial, repository);
    const replayTurn = await interrupted.begin("turn", [], "Prepare");
    replayTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    await interrupted.save();
    const previousLimit = process.env.RESEARCH_CONTEXT_SIZE;
    try {
      process.env.RESEARCH_CONTEXT_SIZE = "12345";
      assert.equal(await prepareInSandbox(interrupted, deps), "Final analysis");
    } finally {
      if (previousLimit === undefined) delete process.env.RESEARCH_CONTEXT_SIZE; else process.env.RESEARCH_CONTEXT_SIZE = previousLimit;
    }
    assert.ok(tasks.slice(beforeInterruption).every((task) => task.maxOutputTokens === 32_000), "a resumed binding keeps its original cap");
    assert.deepEqual(tasks.slice(beforeInterruption).map((task) => task.toolChoice), ["auto", "auto", "none"]);
    assert.equal(tasks[beforeInterruption].callId, tasks[beforeInterruption + 1].callId, "replay must retain the call ID and tool choice for the broker's request hash");
    assert.equal(resumes, 1, "the retry resumes the VM of the interrupted call");
    assert.equal(replayTurn.preparationToolChoice, undefined);

    const legacy = await PhaseSession.open("fixture-legacy", initial, repository);
    const legacyTurn = await legacy.begin("turn", [], "Prepare");
    legacyTurn.preparationBound = true; // An existing pre-configuration binding.
    legacyTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    assert.equal(await prepareInSandbox(legacy, deps), "Final analysis");
    assert.equal(tasks.at(-1)?.maxOutputTokens, 4096);

    const debate = await PhaseSession.open("fixture-debate", { ...initial, phase: "debate" }, repository);
    const closed = { type: "instruction_closed" as const, seq: 1, at: "2026-11-07T00:00:00.000Z" };
    const debateTurn = await debate.begin("turn", [closed], "Prepare");
    debateTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    assert.equal(await prepareInSandbox(debate, deps), "Final analysis");
    assert.equal(tasks.at(-1)?.maxOutputTokens, 8000, "debate preparation uses its phase limit");

    const nearDeadline = await PhaseSession.open("fixture-deadline", initial, repository);
    const deadlineTurn = await nearDeadline.begin("turn", [], "Prepare");
    deadlineTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    assert.equal(await prepareInSandbox(nearDeadline, deps), "Final analysis");
    assert.equal(deadlineTurn.steps, 1, "little remaining time must force synthesis immediately");
    assert.equal(tasks.at(-1)?.toolChoice, "none");
    assert.ok(tasks.at(-1)!.timeoutMs > 0 && tasks.at(-1)!.timeoutMs <= 30_000);

    const expired = await PhaseSession.open("fixture-expired", initial, repository);
    const expiredTurn = await expired.begin("turn", [], "Prepare");
    expiredTurn.expiresAt = new Date(Date.now() - 1).toISOString();
    const beforeExpiry = runs;
    await assert.rejects(prepareInSandbox(expired, deps), (error) => FatalError.is(error) && /budget exhausted/.test(error.message));
    assert.equal(runs, beforeExpiry, "an expired checkpoint must not spend another model call");
    assert.equal(expiredTurn.complete, false);
    assert.equal(expired.state.activeTurn, undefined);
    synthesize = false;

    for (const [finishReason, text] of [["length", "truncated"], ["stop", "  "], ["stop", "Final analysis"]]) {
      const next = await PhaseSession.open(`fixture-${finishReason}-${text.trim() ? "text" : "empty"}`, initial, repository);
      await next.begin("turn", [], "Prepare");
      response = { messages: [{ role: "assistant", content: text }], text, finishReason };
      if (text === "Final analysis") {
        assert.equal(await prepareInSandbox(next, deps), text);
        assert.equal(next.state.turns.turn.complete, true);
      } else {
        await assert.rejects(prepareInSandbox(next, deps), (error) => FatalError.is(error) && /without a complete final response/.test(error.message));
        assert.equal(next.state.turns.turn.complete, false);
      }
      assert.equal(next.state.activeTurn, undefined);
    }
    const failed = await PhaseSession.open("fixture-command-failure", initial, repository);
    await failed.begin("turn", [], "Prepare");
    exitCode = 1;
    await assert.rejects(prepareInSandbox(failed, deps), /Brokered preparation failed \(exit 1\); refusing independent processing fallback/);
    assert.equal(failed.state.turns.turn.complete, false);
    assert.equal(failed.state.activeTurn, undefined);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

test("a call that outlasts one wait continues in a later unit, keeping its grant and its VM", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    let runs = 0, stops = 0, binds = 0, finished = false;
    const running = { cmdId: "call-1", wait: ({ signal }: { signal: AbortSignal }) => finished ? Promise.resolve({ exitCode: 0 }) : new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) };
    const sandbox = {
      name: "persistent-slow", status: "running", writeFiles: async () => {},
      update: async (policy: typeof PREPARATION_SNAPSHOTS) => { assert.deepEqual(policy, PREPARATION_SNAPSHOTS); },
      runCommand: async (command: { cmd: string }) => { if (command.cmd === "node") { runs++; return running; } return { exitCode: 0 }; },
      getCommand: async (id: string) => { assert.equal(id, "call-1"); return running; },
      readFileToBuffer: async () => Buffer.from(JSON.stringify({ messages: [{ role: "assistant", content: "Slow analysis" }], text: "Slow analysis", finishReason: "stop" })),
      stop: async () => { stops++; },
    };
    const deps = {
      sandbox: { create: async () => sandbox, get: async () => sandbox } as unknown as typeof Sandbox,
      bind: async () => { binds++; },
    };
    const repository = new MemoryPhaseRepository();
    const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Canonical material" };
    const session = await PhaseSession.open("fixture-slow", initial, repository);
    await session.begin("turn", [], "Prepare");
    assert.equal(await advancePreparation(session, deps, {}, 10), undefined);
    assert.equal(session.state.activeTurn?.preparationCommand?.id, "call-1");
    assert.equal(stops, 0, "the VM keeps running the call between units");

    // A later unit runs in another step: it reloads the checkpoint and reopens the VM.
    const resumed = await PhaseSession.open("fixture-slow", initial, repository);
    await resumed.begin("turn", [], "Prepare");
    assert.equal(resumed.state.activeTurn?.id, "turn", "the grant stays active while the call runs");
    assert.equal(await advancePreparation(resumed, deps, {}, 10), undefined);
    finished = true;
    assert.equal(await advancePreparation(resumed, deps, {}, 10), "Slow analysis");
    assert.equal(runs, 1, "waiting again never starts the call again");
    assert.equal(binds, 1, "a turn is bound once");
    assert.equal(resumed.state.turns.turn.complete, true);
    assert.equal(resumed.state.activeTurn, undefined);
    assert.equal(stops, 1, "the VM stops once the turn completes");
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

type Listed = { name: string; status: string; tags?: Record<string, string> };

test("tool calls end before the synthesis reserve, and one that runs out of time still reaches synthesis", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    const tasks: Array<{ toolChoice: string; timeoutMs: number }> = [];
    let results: object[] = [];
    // A call that times out has used up its time: move the turn's deadline as the clock would.
    let elapse = (_ms: number) => {};
    const sandbox = {
      name: "persistent-reserve", status: "running",
      update: async (policy: typeof PREPARATION_SNAPSHOTS) => { assert.deepEqual(policy, PREPARATION_SNAPSHOTS); },
      writeFiles: async (files: { path: string; content: string }[]) => {
        const task = files.find((file) => file.path === "/workspace/task.json");
        if (task) tasks.push(JSON.parse(task.content));
      },
      runCommand: async (command: { cmd: string }) => command.cmd === "node" ? { cmdId: `call-${tasks.length}`, wait: async () => ({ exitCode: 0 }) } : { exitCode: 0 },
      getCommand: async () => { throw new Error("Command not found"); },
      readFileToBuffer: async () => {
        const result = results.shift() as { finishReason: string };
        if (result.finishReason === "timeout") elapse(tasks.at(-1)!.timeoutMs);
        return Buffer.from(JSON.stringify(result));
      },
      stop: async () => {},
    };
    const deps = { sandbox: { create: async () => sandbox, get: async () => sandbox } as unknown as typeof Sandbox, bind: async () => {} };
    const repository = new MemoryPhaseRepository();
    const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Canonical material" };
    const timedOut = { messages: [], text: "", finishReason: "timeout" };
    const final = { messages: [{ role: "assistant", content: "Final analysis" }], text: "Final analysis", finishReason: "stop" };

    const session = await PhaseSession.open("fixture-reserve", initial, repository);
    const turn = await session.begin("turn", [], "Prepare");
    turn.expiresAt = new Date(Date.now() + 200_000).toISOString();
    await session.save();
    elapse = (ms) => { turn.expiresAt = new Date(Date.parse(turn.expiresAt) - ms).toISOString(); };
    results = [timedOut, final];
    assert.equal(await prepareInSandbox(session, deps), "Final analysis");
    assert.deepEqual(tasks.map((task) => task.toolChoice), ["auto", "none"]);
    assert.ok(tasks[0].timeoutMs <= 200_000 - PREPARATION_SYNTHESIS_MS - 5000, "a call with tools ends before the synthesis reserve");
    assert.ok(tasks[1].timeoutMs >= PREPARATION_SYNTHESIS_MS - 10_000, "the synthesis gets the reserved time");
    assert.equal(turn.steps, 2, "a timed-out tool call spends its step");
    assert.equal(turn.complete, true);

    const late = await PhaseSession.open("fixture-reserve-late", initial, repository);
    const lateTurn = await late.begin("turn", [], "Prepare");
    lateTurn.expiresAt = new Date(Date.now() + 100_000).toISOString();
    await late.save();
    results = [timedOut];
    await assert.rejects(prepareInSandbox(late, deps), (error) => FatalError.is(error) && /without a complete final response/.test(error.message));
    assert.equal(tasks.at(-1)?.toolChoice, "none", "a synthesis that runs out of time fails closed");
    assert.equal(lateTurn.complete, false);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

function sandboxes(listed: Listed[], deleted: string[]) {
  const missing = Object.assign(new Error("Named sandbox not found"), { response: { status: 404 } });
  return {
    list: async ({ tags }: { tags?: Record<string, string> } = {}) => {
      const items = listed.filter((item) => !tags || Object.entries(tags).every(([key, value]) => item.tags?.[key] === value));
      return { toArray: async () => items };
    },
    get: async ({ name }: { name: string }) => {
      if (name === "gone" || deleted.includes(name)) throw missing;
      return {
        delete: async (options: { deleteOrphanSnapshots: boolean }) => {
          assert.equal(options.deleteOrphanSnapshots, true);
          if (name === "broken") throw new Error("gone");
          deleted.push(name);
        },
      };
    },
  } as unknown as typeof Sandbox;
}

test("automatic deletion retains bound and tagged resources regardless of terminal status or missing ownership evidence", async () => {
  const deleted: string[] = [];
  const sandbox = sandboxes([], deleted);
  let reads = 0;
  for (const id of ["failed", "resolved", "missing", "renamed", "lease-expired", "cancelled", "generation-2", "x".repeat(32), "x".repeat(40)]) {
    await assert.rejects(deleteCaseSandboxes(id, { sandbox, names: async () => { reads++; return ["a", "b"]; } }), SandboxCleanupBlockedError);
  }
  assert.equal(reads, 0, "cleanup must not wait on the row lock already held by an administrative reset");
  assert.deepEqual(deleted, []);
});

test("administrative cleanup blocks before Blob or sandbox removal and propagates the block", async () => {
  const deleted: string[] = [];
  const sandbox = sandboxes([
    { name: "prep-old-name", status: "stopped", tags: { case: "AA-123-BB", phase: "instruction", seat: "grok" } },
    { name: "prep-renamed", status: "stopped", tags: { case: "old_id", phase: "intake", seat: "judge" } },
    { name: "other-case", status: "stopped", tags: { case: "CC-456-DD", phase: "instruction", seat: "grok" } },
    { name: "harness-build", status: "stopped" },
  ], deleted);
  const blobs: string[][] = [];
  const cleanup = withSandboxCleanup(async (ids) => { blobs.push(ids); }, (caseId) => deleteCaseSandboxes(caseId, { sandbox, names: async () => [] }));
  const warn = console.warn;
  console.warn = () => {};
  try { await assert.rejects(cleanup(["AA-123-BB", "old_id"]), SandboxCleanupBlockedError); }
  finally { console.warn = warn; }
  assert.deepEqual(blobs, []);
  assert.deepEqual(deleted, []);
  await assert.rejects(withSandboxCleanup(async () => { throw new Error("must not reach Blob"); }, async () => {})(["AA-123-BB"]), SandboxCleanupBlockedError);
});

test("the sweep retains failed, resolved, orphaned and ambiguously tagged snapshots without a status-cache deletion race", async (t) => {
  const deleted: string[] = [];
  const prep = (name: string, caseId: string, status = "stopped") => ({ name, status, tags: { case: caseId, phase: "instruction", seat: "grok" } });
  const sandbox = sandboxes([
    prep("resolved", "AA-111-AA"), prep("failed", "AA-222-AA", "failed"), prep("deleted-case", "AA-333-AA"),
    prep("in-session", "AA-444-AA"), prep("queued", "AA-555-AA"), prep("running", "AA-111-AA", "running"),
    prep("truncated-id", "x".repeat(32)),
    { name: "evidence-step", status: "stopped", tags: { case: "AA-111-AA", seat: "grok", stage: "exposicion" } },
    { name: "harness-build", status: "stopped" }, { name: "smoke", status: "stopped", tags: { purpose: "smoke" } },
  ], deleted);
  const statuses: Record<string, string> = { "AA-111-AA": "resolved", "AA-222-AA": "failed", "AA-444-AA": "in_session", "AA-555-AA": "queued" };
  let reads = 0;
  const warning = t.mock.method(console, "warn", () => {});
  const swept = await sweepCaseSandboxes({ sandbox, caseStatus: async (caseId) => { reads++; return statuses[caseId]; } });
  assert.deepEqual(swept, []);
  assert.deepEqual(deleted, []);
  assert.equal(reads, 0);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /cleanup blocked/);
});


test("pipeline 3 prepares with one native research call and files nothing when it times out", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "CONTEXT_SIZE", "RESEARCH_CONTEXT_SIZE"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    let runs = 0;
    let response: unknown = { messages: [{ role: "assistant", content: "Report" }], text: "Report with quotes", finishReason: "stop", sources: [{ url: "https://example.test/a" }], searches: 3 };
    const tasks: Array<{ tools: unknown[]; maxOutputTokens?: number | null; timeoutMs: number; toolChoice: string }> = [];
    const bindings: Array<{ gatewayTools: unknown[]; maxOutputTokens?: number | null }> = [];
    const sandbox = {
      update: async (policy: typeof PREPARATION_SNAPSHOTS) => { assert.deepEqual(policy, PREPARATION_SNAPSHOTS); },
      name: "native-fixture",
      writeFiles: async (files: { path: string; content: string }[]) => { const task = files.find((file) => file.path === "/workspace/task.json"); if (task) tasks.push(JSON.parse(task.content)); },
      runCommand: async (command: { cmd: string }) => { if (command.cmd !== "node") return { exitCode: 0 }; runs++; return { cmdId: `call-${runs}`, wait: async () => ({ exitCode: 0 }) }; },
      getCommand: async () => { throw new Error("Command not found"); },
      readFileToBuffer: async () => Buffer.from(JSON.stringify(response)),
      stop: async () => {},
    };
    const deps = {
      sandbox: { create: async () => sandbox, get: async () => sandbox } as unknown as typeof Sandbox,
      bind: async (_caseId: string, _name: string, binding: { gatewayTools: unknown[]; maxOutputTokens?: number | null }) => { bindings.push(binding); },
    };
    const repository = new MemoryPhaseRepository();
    const model = { id: "openai/fixture" };
    const native = nativePreparationDefinitions("instruction", model.id);
    const initial = { phase: "instruction" as const, seat: "chatgpt" as const, channel: "preparation" as const, model, system: "fixture", tools: JSON.stringify(native), initial: "Claims" };
    process.env.CONTEXT_SIZE = "9000";
    process.env.RESEARCH_CONTEXT_SIZE = "12345";
    const session = await PhaseSession.open("fixture-native", initial, repository);
    await session.begin("turn", [], "Research");
    assert.equal(await prepareInSandbox(session, deps), "Report with quotes");
    assert.equal(runs, 1, "native research is one call, without a step loop");
    assert.deepEqual(tasks[0]!.tools, native);
    assert.equal(tasks[0]!.maxOutputTokens, 12_345);
    assert.equal(tasks[0]!.toolChoice, "auto");
    assert.ok(tasks[0]!.timeoutMs > 250_000 && tasks[0]!.timeoutMs <= 300_000 - NATIVE_CALL_MARGIN_MS, "the call may use the turn, less its margin");
    assert.deepEqual(bindings[0], { ...bindings[0], gatewayTools: native, maxOutputTokens: 12_345 });
    assert.equal(session.state.turns.turn!.complete, true);
    assert.equal(session.state.turns.turn!.timedOut, undefined);

    const legacy = await PhaseSession.open("fixture-native-legacy", initial, repository);
    const legacyTurn = await legacy.begin("turn", [], "Research");
    legacyTurn.preparationBound = true;
    assert.equal(await prepareInSandbox(legacy, deps), "Report with quotes");
    assert.equal(tasks.at(-1)!.maxOutputTokens, null, "existing native bindings remain uncapped");
    assert.equal(bindings.length, 1, "an existing binding is not replaced");

    response = { messages: [{ role: "assistant", content: "Incomplete report" }], text: "Incomplete report", finishReason: "length", sources: [], searches: 1 };
    const truncated = await PhaseSession.open("fixture-native-truncated", initial, repository);
    await truncated.begin("turn", [], "Research");
    await assert.rejects(prepareInSandbox(truncated, deps), /output token limit reached/);
    assert.equal(truncated.state.turns.turn!.complete, false, "a truncated report is not treated as complete");

    response = { messages: [], text: "", finishReason: "timeout" };
    const slow = await PhaseSession.open("fixture-native-timeout", initial, repository);
    await slow.begin("turn", [], "Research");
    assert.equal(await prepareInSandbox(slow, deps), "", "a timed-out call files nothing instead of failing the case");
    assert.equal(slow.state.turns.turn!.timedOut, true);
    assert.equal(slow.state.turns.turn!.complete, true);

    const late = await PhaseSession.open("fixture-native-late", initial, repository);
    const lateTurn = await late.begin("turn", [], "Research");
    lateTurn.expiresAt = new Date(Date.now() + NATIVE_CALL_MARGIN_MS).toISOString();
    const before = runs;
    assert.equal(await prepareInSandbox(late, deps), "");
    assert.equal(runs, before, "no call starts without time for it");
    assert.equal(late.state.turns.turn!.timedOut, true);

    // Intake keeps the pipeline 2 host tools.
    assert.ok(nativePreparationDefinitions("intake", model.id).every((definition) => definition.type === "function"));
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
