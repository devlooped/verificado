import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { MemoryPhaseRepository, PhaseSession } from "../court/phase-session.ts";
import { sourceOperationRepositoryFor } from "../store.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { sha256 } from "../evidence/validate.ts";
import { advancePreparation, prepareInSandbox } from "./preparation.ts";
import { createTurnProxy } from "./proxy.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { SourceService, type SourceDependencies } from "./sources.ts";
import { runCall } from "../../sandbox/harness/instruction-agent.ts";
import type { SandboxBinding } from "./authorization.ts";

function denyNetwork(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  for (const method of ["connect", "query"] as const) t.mock.method(Pool.prototype, method, (() => { throw new Error("DB forbidden"); }) as never);
}

function bridgeEnvironment(t: TestContext) {
  const values = { INSTRUCTION_TOOL_ORIGIN: "https://fixture.example", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture", INSTRUCTION_SANDBOX_TEAM_ID: "team", INSTRUCTION_SANDBOX_PROJECT_ID: "project" };
  const previous = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  t.after(() => previous.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
}

const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Fixture" };

test("SourceService rejects explicit generational repository scope before any DB, artifacts or stage effects", async (t) => {
  denyNetwork(t);
  let effects = 0;
  const forbidden = async (): Promise<never> => { effects++; throw new Error("Effect forbidden"); };
  const deps: SourceDependencies = { operations: sourceOperationRepositoryFor({ generation: 1, runId: "run" }),
    artifacts: { read: forbidden, write: forbidden }, download: forbidden, extract: forbidden, translate: forbidden,
    verifyLanguage: forbidden, translatorModelId: "fixture/model", translatorFingerprint: "fixture" };
  assert.throws(() => new SourceService("fixture", "es", deps), /Generational source execution blocked/);
  assert.equal(effects, 0);
  // Merely naming a legacy key "generation" does not change its contract.
  const legacy = new SourceService("fixture", "es", { ...deps, operations: new MemoryOperationRepository() });
  assert.equal(await legacy.hostStage("generation:1:call", "fixture", async () => "legacy result"), "legacy result");
});

test("new preparation blocks fresh, done, expired and lost-command states without save, cleanup or SDK access", async (t) => {
  denyNetwork(t);
  const repository = new MemoryPhaseRepository();
  const session = await PhaseSession.open("fixture", initial, repository);
  const turn = await session.begin("turn", [], "Prepare");
  let effects = 0;
  const forbidden = async (): Promise<never> => { effects++; throw new Error("Effect forbidden"); };
  const sandbox = { name: "fixture", getCommand: forbidden, runCommand: forbidden, writeFiles: forbidden, readFileToBuffer: forbidden, update: forbidden, stop: forbidden } as unknown as Sandbox;
  const deps = { writer: { generation: 1, runId: "run" }, sandbox: { create: forbidden, get: forbidden } as unknown as typeof Sandbox, bind: forbidden };
  for (const state of [
    { done: false, preparationCommand: undefined, expiresAt: new Date(Date.now() + 300_000).toISOString() },
    { done: false, preparationCommand: { id: "possibly-executed", resultPath: "/workspace/result.json" }, expiresAt: new Date(0).toISOString() },
    { done: true, preparationCommand: undefined, expiresAt: new Date(0).toISOString() },
  ]) {
    Object.assign(turn, state); await session.save();
    const before = structuredClone(session.state), durableBefore = structuredClone(repository.states);
    await assert.rejects(advancePreparation(session, deps, { sandbox }), /Generational preparation blocked/);
    await assert.rejects(prepareInSandbox(session, deps), /Generational preparation blocked/);
    assert.deepEqual(session.state, before); assert.deepEqual(repository.states, durableBefore);
  }
  assert.equal(effects, 0);
});

test("legacy lost detached-launch response can relaunch an executed command with the same call ID", async (t) => {
  denyNetwork(t); bridgeEnvironment(t); t.mock.method(console, "warn", () => {});
  let launches = 0;
  const tasks: Array<{ callId: string; toolChoice: string }> = [];
  const sandbox = {
    name: "fixture", update: async () => {}, stop: async () => {},
    writeFiles: async (files: Array<{ path: string; content: string }>) => {
      const task = files.find((f) => f.path === "/workspace/task.json"); if (task) tasks.push(JSON.parse(task.content));
    },
    runCommand: async ({ cmd }: { cmd: string }) => {
      if (cmd !== "node") return { exitCode: 0 };
      launches++; // The mock accepted/executed the command before losing reply.
      if (launches === 1) throw new Error("Detached launch response lost");
      return { cmdId: "second-launch", wait: async () => ({ exitCode: 0 }) };
    },
    readFileToBuffer: async () => Buffer.from(JSON.stringify({ messages: [{ role: "assistant", content: "Fixture final" }], text: "Fixture final", finishReason: "stop" })),
  };
  const deps = { sandbox: { create: async () => sandbox, get: async () => sandbox } as unknown as typeof Sandbox, bind: async () => {} };
  const repository = new MemoryPhaseRepository();
  let session = await PhaseSession.open("fixture", initial, repository); await session.begin("turn", [], "Prepare");
  await assert.rejects(advancePreparation(session, deps), /Detached launch response lost/);
  assert.equal(session.state.turns.turn.preparationCommand, undefined);
  session = await PhaseSession.open("fixture", initial, repository); await session.begin("turn", [], "Prepare");
  assert.equal(await advancePreparation(session, deps), "Fixture final");
  assert.equal(launches, 2); assert.equal(tasks[0].callId, tasks[1].callId); assert.equal(tasks[0].toolChoice, tasks[1].toolChoice);
});

test("legacy get/wait loss clears the command handle and permits same-call relaunch; new scope blocks it", async (t) => {
  denyNetwork(t); bridgeEnvironment(t); t.mock.method(console, "warn", () => {});
  for (const lost of ["get", "wait"]) {
    const repository = new MemoryPhaseRepository();
    const session = await PhaseSession.open(`fixture-${lost}`, initial, repository);
    const turn = await session.begin("turn", [], "Prepare");
    turn.preparationCommand = { id: "executed", resultPath: "/workspace/result.json" };
    turn.preparationToolChoice = "auto"; session.state.sandboxId = "fixture"; await session.save();
    let commands = 0;
    const sandbox = {
      name: "fixture", update: async () => {}, stop: async () => {},
      getCommand: async () => {
        commands++;
        if (lost === "get") throw new Error("Command lookup lost");
        return { wait: async () => { throw new Error("Wait response lost"); } };
      },
    };
    const deps = { sandbox: { get: async () => sandbox } as unknown as typeof Sandbox, bind: async () => {} };
    await assert.rejects(advancePreparation(session, { ...deps, writer: { generation: 1, runId: "run" } }), /Generational preparation blocked/);
    assert.equal(commands, 0); assert.equal(turn.preparationCommand.id, "executed");
    assert.equal(await advancePreparation(session, deps), undefined);
    assert.equal(turn.preparationCommand, undefined); assert.equal(turn.preparationToolChoice, "auto"); assert.equal(commands, 1);
  }
});

test("installed Sandbox transport retries a lost POST response without a durable command intention", async (t) => {
  denyNetwork(t);
  // Exercise the installed wrapper itself, with a local fetch double only.
  const { withRetry } = await import(new URL("./api-client/with-retry.js", import.meta.resolve("@vercel/sandbox")).href) as {
    withRetry: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  };
  let attempts = 0;
  const post = withRetry((async (_url, init) => {
    assert.equal(init?.method, "POST"); assert.equal(init?.body, '{"command":"node"}');
    attempts++; throw new TypeError("Accepted POST, response lost");
  }) as typeof fetch);
  await assert.rejects(post("https://fixture.invalid/cmd", { method: "POST", body: '{"command":"node"}' }), /response lost/);
  assert.equal(attempts, 3, "installed default is two retries, even for POST network failure");
});

test("AI harness maxRetries=0 sends one request on retryable provider rejection or response loss", async (t) => {
  const task = { caseId: "fixture", callId: "turn:0", model: { id: "fixture/model" }, system: "Fixture", messages: [{ role: "user" as const, content: "Prepare" }], tools: [], resultPath: "/workspace/result.json" };
  for (const lost of [false, true]) {
    let attempts = 0;
    const mocked = t.mock.method(globalThis, "fetch", (async (_url, init) => {
      attempts++; assert.equal(new Headers(init?.headers).get("x-court-call-id"), task.callId);
      if (lost) throw new TypeError("Provider response lost");
      return Response.json({ error: { message: "Fixture unavailable" } }, { status: 503 });
    }) as typeof fetch);
    await assert.rejects(runCall(task)); assert.equal(attempts, 1); mocked.mock.restore();
  }
});

test("legacy broker deduplicates paid generation, but input equality is checked after hostStage", async (t) => {
  denyNetwork(t); t.mock.method(console, "warn", () => {});
  const operations = new MemoryOperationRepository(), artifacts = new MemoryArtifactStore();
  let generations = 0, hashAtEffect: string | undefined, inputAtEffect: string | undefined;
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected effect"); };
  const reader = new SourceService("fixture", "es", { operations, artifacts, translatorModelId: "fixture", translatorFingerprint: "fixture",
    download: forbidden, extract: forbidden, translate: forbidden, verifyLanguage: forbidden });
  const binding: SandboxBinding = { phase: "instruction", seat: "grok", sessionKey: "instruction:grok:preparation", phaseSessionId: "phase", expiresAt: "2030-01-01", revoked: false, model: { id: "fixture/model" }, gatewayTools: [], activeTurn: { id: "turn", expiresAt: "2030-01-01", remainingRequests: 10 } };
  const key = `sandbox-generation:phase:${sha256("turn:0")}`;
  const proxy = createTurnProxy({ origin: "https://fixture.example", teamId: "team", projectId: "project" }, {
    consume: async () => ({ caseId: "fixture", binding }), getCase: async () => ({ id: "fixture" }), reader: () => reader,
    artifacts, audit: async () => {}, generate: async () => {
      generations++; const operation = await operations.get("fixture", key);
      assert.equal(operation?.status, "running"); hashAtEffect = operation.inputHash; inputAtEffect = operation.inputJson;
      return JSON.stringify({ content: [{ type: "text", text: "Fixture" }], finishReason: { unified: "stop", raw: "stop" } });
    },
  } as unknown as Parameters<typeof createTurnProxy>[1]);
  const request = (text: string) => new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", headers: { "ai-language-model-id": "fixture/model", "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false", "x-court-call-id": "turn:0" }, body: JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: [], maxOutputTokens: 4096 }) });
  const meta = { teamId: "team", projectId: "project", sandboxName: "fixture" } as Parameters<typeof proxy>[1];
  assert.equal((await proxy(request("original"), meta)).status, 200);
  assert.equal(hashAtEffect, undefined); assert.equal(inputAtEffect, undefined);
  assert.equal((await proxy(request("original"), meta)).status, 200);
  assert.equal((await proxy(request("changed"), meta)).status, 403);
  assert.equal(generations, 1);
  binding.writer = { generation: 1, runId: "run" };
  assert.equal((await proxy(request("original"), meta)).status, 403);
  assert.equal(generations, 1, "new scope never enters legacy hostStage");
});
