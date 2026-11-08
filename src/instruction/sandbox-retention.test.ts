import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { Pool } from "pg";
import { MemoryPhaseRepository, PhaseSession } from "../court/phase-session.ts";
import { advancePreparation, deleteCaseSandboxes, PREPARATION_SNAPSHOTS, prepareInSandbox, SandboxCleanupBlockedError, sweepCaseSandboxes, withSandboxCleanup } from "./preparation.ts";

const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Synthetic material" };

function bridge(t: TestContext) {
  const values = { INSTRUCTION_TOOL_ORIGIN: "https://fixture.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" };
  const previous = Object.keys(values).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
}

test("future snapshots survive repeated stops; retention is updated before resumed commands, without rewriting historical expiration", async t => {
  bridge(t);
  const order: string[] = [];
  const snapshots = [{ name: "historical", expires: 86_400_000 }];
  let policy = { snapshotExpiration: 86_400_000, keepLastSnapshots: { count: 1, expiration: 86_400_000, deleteEvicted: true } };
  const sandbox = {
    name: "fixture-persistent", status: "running",
    update: async (input: typeof PREPARATION_SNAPSHOTS) => { order.push("retain"); policy = structuredClone(input); },
    writeFiles: async () => {},
    runCommand: async ({ cmd }: { cmd: string }) => {
      order.push(cmd);
      assert.deepEqual(policy, PREPARATION_SNAPSHOTS);
      return { exitCode: 0, cmdId: "fixture-command", wait: async () => ({ exitCode: 0 }) };
    },
    readFileToBuffer: async () => Buffer.from(JSON.stringify({ messages: [{ role: "assistant", content: "Final" }], text: "Final", finishReason: "stop" })),
    stop: async () => {
      order.push("stop");
      if (policy.keepLastSnapshots.deleteEvicted) snapshots.splice(0);
      snapshots.push({ name: `new-${snapshots.length}`, expires: policy.snapshotExpiration });
    },
  };
  const deps = { sandbox: {
    create: async () => { throw new Error("Never recreate a retained VM"); },
    get: async (input: { name: string; resume?: boolean }) => { assert.equal(input.resume, false); assert.equal(input.name, sandbox.name); order.push("get-without-resume"); return sandbox; },
  } as unknown as typeof Sandbox, bind: async () => {} };
  const repository = new MemoryPhaseRepository();
  const session = await PhaseSession.open("fixture", initial, repository);
  session.state.sandboxId = sandbox.name;
  await session.save();
  for (const id of ["first", "second"]) { await session.begin(id, [], "Prepare"); assert.equal(await prepareInSandbox(session, deps), "Final"); }
  assert.deepEqual(order, ["get-without-resume", "retain", "mkdir", "node", "retain", "stop", "get-without-resume", "retain", "mkdir", "node", "retain", "stop"]);
  assert.deepEqual(snapshots.map(item => item.expires), [86_400_000, 0, 0], "old expiration is not retroactively changed or claimed recoverable");
  assert.equal((await repository.load("fixture", session.key))?.body.sandboxId, sandbox.name);
});

test("failed retention updates or missing snapshots block before resume/generation, with no fresh VM fallback", async t => {
  bridge(t);
  for (const missing of [false, true]) {
    let commands = 0, stops = 0, creates = 0, binds = 0;
    const sandbox = { name: "historical", status: "running",
      update: async () => { throw new Error("retention quota unavailable"); },
      stop: async () => { stops++; }, runCommand: async () => { commands++; },
    };
    const deps = { sandbox: { create: async () => { creates++; throw new Error("forbidden fallback"); }, get: async ({ resume }: { resume?: boolean }) => {
      assert.equal(resume, false); if (missing) throw new Error("snapshot_not_found"); return sandbox;
    } } as unknown as typeof Sandbox, bind: async () => { binds++; } };
    const repository = new MemoryPhaseRepository();
    const session = await PhaseSession.open(`fixture-${missing}`, initial, repository);
    session.state.sandboxId = sandbox.name; await session.save(); await session.begin("turn", [], "Prepare");
    await assert.rejects(advancePreparation(session, deps), missing ? /snapshot_not_found/ : /retention quota/);
    assert.deepEqual([commands, stops, creates, binds], [0, 0, 0, 0]);
    assert.equal((await repository.load(session.caseId, session.key))?.body.sandboxId, sandbox.name);
  }
});

test("concurrent cleanup and sweep perform zero DB/provider operations, even while a legacy writer has not settled", async t => {
  let effects = 0;
  const forbidden = async () => { effects++; throw new Error("forbidden cleanup effect"); };
  t.mock.method(Pool.prototype, "query", forbidden as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", forbidden as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(Sandbox, "list", forbidden as unknown as typeof Sandbox.list);
  t.mock.method(Sandbox, "get", forbidden as unknown as typeof Sandbox.get);
  t.mock.method(console, "warn", () => {});
  const pendingWriter = Promise.withResolvers<void>();
  let settled = false;
  const lateWriter = pendingWriter.promise.then(() => { settled = true; });
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => deleteCaseSandboxes("failed-or-reserved")));
  assert.ok(attempts.every(result => result.status === "rejected" && result.reason instanceof SandboxCleanupBlockedError));
  assert.deepEqual(await Promise.all([sweepCaseSandboxes(), sweepCaseSandboxes()]), [[], []]);
  assert.equal(settled, false);
  assert.equal(effects, 0);
  pendingWriter.resolve(); await lateWriter;
  await assert.rejects(deleteCaseSandboxes("resolved-after-writer"), SandboxCleanupBlockedError);
  assert.equal(effects, 0, "settling one known writer does not prove the whole historical set");
});

test("a retention failure at stop blocks completion instead of explicitly stopping under an unsafe policy", async t => {
  bridge(t);
  let commands = 0, stops = 0;
  const sandbox = { name: "fixture-new", writeFiles: async () => {},
    update: async () => { throw new Error("quota unavailable"); },
    runCommand: async ({ cmd }: { cmd: string }) => { if (cmd === "node") commands++; return { cmdId: "fixture-command", wait: async () => ({ exitCode: 0 }) }; },
    readFileToBuffer: async () => Buffer.from(JSON.stringify({ messages: [{ role: "assistant", content: "Durable final" }], text: "Durable final", finishReason: "stop" })),
    stop: async () => { stops++; },
  };
  const deps = { sandbox: { create: async () => sandbox } as unknown as typeof Sandbox, bind: async () => {} };
  const session = await PhaseSession.open("fixture-stop", initial, new MemoryPhaseRepository());
  await session.begin("turn", [], "Prepare");
  await assert.rejects(prepareInSandbox(session, deps), /retention\/stop uncertain/);
  assert.equal(commands, 1);
  assert.equal(stops, 0);
  assert.equal(session.state.turns.turn.complete, true, "keep the completed response instead of spending its budget again");
  assert.equal(session.state.sandboxId, sandbox.name);
});

test("concurrent callback batches, including aliases, block before any injected removal or Blob effect", async t => {
  let effects = 0;
  const forbidden = async () => { effects++; throw new Error("forbidden removal"); };
  t.mock.method(globalThis, "fetch", forbidden);
  const callback = withSandboxCleanup(forbidden, forbidden);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => callback(["case", "old-id", "other-id"])));
  assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof SandboxCleanupBlockedError));
  await callback([]);
  assert.equal(effects, 0);
});
