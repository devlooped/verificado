import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { MockLanguageModelV4 } from "ai/test";
import { continuationHash, CONTINUATION_ENABLED } from "../domain/continuation.ts";
import type { CaseRecord } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { MemoryOperationRepository } from "../instruction/source-store.ts";
import { SourceService, extractSource } from "../instruction/sources.ts";
import { DEFAULT_MODELS, modelSnapshot } from "./models.ts";
import { createMockSeat } from "./mock.ts";
import { advanceSharedTurn } from "./settled-play.ts";
import { PhaseSession, MemoryPhaseRepository, phaseSystem } from "./phase-session.ts";
import { verifyPhaseSessionExport, phaseSessionExportPreflight, type PhaseSessionExport, type PhaseSessionExpectation } from "./phase-session-export.ts";

async function fixture(channel: "preparation" | "decision" = "decision", pipeline: 2 | 3 | 4 | 5 = 2, phase: "intake" | "instruction" = "intake") {
  const repository = new MemoryPhaseRepository();
  const configuration = { phase, seat: "judge" as const, channel, model: { id: "fixture/model" },
    system: phaseSystem(phase, "judge", "es", channel), tools: "{}", initial: "original prefix á 😀" };
  const session = await PhaseSession.open("fixture", configuration, repository);
  await session.begin("turn", [], "original task", channel === "decision" && pipeline >= 3 && phase === "instruction" ? 600_000 : undefined);
  const row = (await repository.load("fixture", session.key))!;
  const exported: PhaseSessionExport = { schemaVersion: 1, kind: "phase_session_offline_export",
    origin: { caseId: "fixture", pipeline, generation: 0, runId: "fixture-run", deploymentId: "fixture-deployment",
      sessionId: session.state.id, sessionKey: session.key, storageKey: session.key }, revision: row.revision, body: row.body };
  return { session, repository, exported, configuration };
}
function expectation(exported: PhaseSessionExport): PhaseSessionExpectation {
  const { body } = exported;
  return { origin: structuredClone(exported.origin), revision: exported.revision, exportHash: continuationHash(exported),
    configuration: { phase: body.phase, seat: body.seat, channel: body.channel, model: structuredClone(body.model),
      system: body.system, tools: body.tools, initialMessageHash: continuationHash(body.messages[0]) }, observedAt: Object.values(body.turns)[0].startedAt };
}
const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const inspect = (exported: PhaseSessionExport) => verifyPhaseSessionExport(expectation(exported), exported);
function mutateTurn(exported: PhaseSessionExport, change: (saved: PhaseSessionExport["body"]["turns"][string]) => void) {
  change(exported.body.turns.turn);
  if (exported.body.activeTurn) exported.body.activeTurn = structuredClone(exported.body.turns.turn);
}

test("offline envelope inspects real memory-CAS state without touching runtime or publishing a checkpoint", async (t) => {
  const { exported } = await fixture();
  const expected = expectation(exported), before = JSON.stringify(exported);
  let dbCalls = 0, effects = 0;
  t.mock.method(Pool.prototype, "query", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", async () => { effects++; throw new Error("External effects forbidden"); });
  t.mock.method(Date, "now", () => { effects++; throw new Error("Clock forbidden"); });
  const report = verifyPhaseSessionExport(expected, roundtrip(exported));
  assert.equal(report.state, "verified-offline"); assert.equal(report.continuationEnabled, false);
  assert.equal(report.turns[0].status, "interrupted");
  for (const field of ["body", "result", "resultRef", "checkpoint", "remainingBudget"]) assert.equal(Object.hasOwn(report, field), false);
  assert.equal(JSON.stringify(exported), before); assert.equal(dbCalls, 0); assert.equal(effects, 0);
  assert.equal(CONTINUATION_ENABLED, false);
  assert.equal(phaseSessionExportPreflight().state, "blocked");
  assert.ok(report.blockers.length >= 6);
});

test("generation, physical/logical key, run/deployment, identity and CAS revision are explicit, never inferred", async () => {
  const { exported } = await fixture();
  const expected = expectation(exported);
  for (const changes of [{ caseId: "other" }, { pipeline: 3 as const }, { generation: 1 }, { runId: "other" },
    { deploymentId: "other" }, { sessionId: "other" }, { sessionKey: "other" }, { storageKey: "other" }]) {
    const other = structuredClone(exported); Object.assign(other.origin, changes);
    assert.throws(() => verifyPhaseSessionExport(expected, other), /mismatch/);
  }
  const revised = structuredClone(exported); revised.revision++;
  assert.throws(() => verifyPhaseSessionExport(expected, revised), /revision mismatch/);
  assert.throws(() => verifyPhaseSessionExport(expected, exported.body)); // Bare legacy is not silently wrapped.
  const isolated = structuredClone(exported); isolated.origin.generation = 2;
  assert.throws(() => inspect(isolated), /namespace mismatch/);
  isolated.origin.storageKey = `generation:2:${isolated.origin.sessionKey}`;
  assert.equal(inspect(isolated).origin.generation, 2); // Consistency only; preflight remains blocked.
  for (const invalid of [1, 6]) {
    const other = structuredClone(exported); Object.assign(other.origin, { pipeline: invalid });
    assert.throws(() => inspect(other));
  }
});

test("effective model/options, prompts, tools and message prefix mismatch; ordinary JSONB key order remains compatible", async () => {
  const { exported } = await fixture();
  exported.body.model.providerOptions = { openai: { promptCacheKey: "pinned-effective-key", reasoningEffort: "high" } };
  const expected = expectation(exported);
  const changedOrder = roundtrip(exported);
  changedOrder.body.model.providerOptions = { openai: { reasoningEffort: "high", promptCacheKey: "pinned-effective-key" } };
  assert.equal(verifyPhaseSessionExport(expected, changedOrder).state, "verified-offline");
  const changes = [
    (body: PhaseSessionExport["body"]) => { body.model.id = "other/model"; },
    (body: PhaseSessionExport["body"]) => { body.model.providerOptions!.openai.reasoningEffort = "low"; },
    (body: PhaseSessionExport["body"]) => { body.system += "changed"; },
    (body: PhaseSessionExport["body"]) => { body.tools = "{ }"; },
    (body: PhaseSessionExport["body"]) => { body.phase = "debate"; },
    (body: PhaseSessionExport["body"]) => { body.seat = "grok"; },
    (body: PhaseSessionExport["body"]) => { body.channel = "preparation"; },
    (body: PhaseSessionExport["body"]) => { body.messages[0].content = "replacement"; },
  ];
  for (const change of changes) {
    const other = roundtrip(exported); change(other.body);
    assert.throws(() => verifyPhaseSessionExport(expected, other), /hash mismatch/);
    const independentlyRehashed = { ...expected, exportHash: continuationHash(other) };
    assert.throws(() => verifyPhaseSessionExport(independentlyRehashed, other), /configuration\/prefix mismatch/);
  }
  const tail = roundtrip(exported); tail.body.messages.push({ role: "assistant", content: "fabricated tail" });
  assert.throws(() => verifyPhaseSessionExport(expected, tail), /hash mismatch/);
});

test("interruption before append, lost active marker and typed answer are unresolved, not recovered", async () => {
  const { session, repository, exported } = await fixture("decision", 5, "instruction");
  session.state.activeTurn!.inFlightStep = `decision:${session.state.id}:turn:0`;
  await session.save();
  delete session.state.activeTurn; await session.save();
  const row = (await repository.load("fixture", session.key))!;
  exported.body = row.body; exported.revision = row.revision;
  const before = JSON.stringify(exported);
  assert.deepEqual(inspect(exported).turns[0].unresolved, ["model_step_in_flight"]);
  assert.equal(JSON.stringify(exported), before);
  const answer = roundtrip(exported);
  delete answer.body.turns.turn.inFlightStep;
  answer.body.messages.push({ role: "assistant", content: "typed result" });
  Object.assign(answer.body.turns.turn, { steps: 1, reasoned: true, answer: { step: 0, output: { votes: [] } } });
  assert.deepEqual(inspect(answer).turns[0].unresolved, ["typed_answer_not_applied"]);
  for (const changed of [{ step: 1, output: {} }, { step: 0 }, { step: 0, output: {}, error: "bad" }]) {
    const other = roundtrip(answer); other.body.turns.turn.answer = changed;
    assert.throws(() => inspect(other), /answer step\/result mismatch/);
  }
  const failed = roundtrip(answer); failed.body.turns.turn.answer = { step: 0, error: "Original parse error" };
  assert.equal(inspect(failed).turns[0].status, "unresolved");
  assert.equal(failed.body.turns.turn.answer.error, "Original parse error");
});

test("preparation command/binding and launch-without-ID windows cannot authorize restarting a remote call", async () => {
  const { exported } = await fixture("preparation");
  exported.body.sandboxId = "offline-sandbox-claim";
  mutateTurn(exported, saved => { saved.preparationBound = true; saved.preparationToolChoice = "auto"; });
  assert.deepEqual(inspect(exported).turns[0].unresolved, ["preparation_call_outcome_unproved"]);
  mutateTurn(exported, saved => { saved.preparationCommand = { id: "offline-command", resultPath: "/workspace/result-turn-0.json" }; });
  assert.deepEqual(inspect(exported).turns[0].unresolved, ["preparation_command_in_flight"]);
  for (const change of [
    (value: PhaseSessionExport) => { delete value.body.sandboxId; },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.preparationBound = false; }); },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.preparationCommand!.resultPath = "/workspace/other.json"; }); },
  ]) { const other = roundtrip(exported); change(other); assert.throws(() => inspect(other), /command\/binding mismatch/); }
});

test("real step/deadline contracts are inspected at exact boundaries, without replenishment", async () => {
  for (const pipeline of [2, 3, 4, 5] as const) for (const channel of ["preparation", "decision"] as const) {
    const { exported } = await fixture(channel, pipeline, "instruction");
    const limit = channel === "preparation" ? 8 : 20;
    const expected = expectation(exported);
    expected.observedAt = new Date(Date.parse(exported.body.turns.turn.expiresAt) - 1).toISOString();
    assert.equal(verifyPhaseSessionExport(expected, exported).turns[0].deadlineElapsed, false);
    expected.observedAt = exported.body.turns.turn.expiresAt;
    assert.equal(verifyPhaseSessionExport(expected, exported).turns[0].status, "exhausted");
    mutateTurn(exported, saved => { saved.steps = limit; });
    assert.equal(inspect(exported).turns[0].status, "exhausted");
    mutateTurn(exported, saved => { saved.steps++; });
    assert.throws(() => inspect(exported), /budget contract mismatch/);
    mutateTurn(exported, saved => { saved.steps = 0; saved.expiresAt = new Date(Date.parse(saved.expiresAt) + 1).toISOString(); });
    assert.throws(() => inspect(exported), /budget contract mismatch/);
  }
});

test("complete flags, missing results and native empty timeout never prove a recovered outcome", async () => {
  const { exported } = await fixture();
  delete exported.body.activeTurn;
  exported.body.turns.turn.complete = true;
  assert.equal(inspect(exported).turns[0].status, "result-unproved");
  Object.assign(exported.body.turns.turn, { done: true, steps: 1, events: [{ type: "claims_entered", claims: [] }],
    results: { "tool-id": { input: '["fixture",{}]', output: "local result" } } });
  const expected = expectation(exported); expected.observedAt = new Date(Date.parse(exported.body.turns.turn.expiresAt) + 1).toISOString();
  const report = verifyPhaseSessionExport(expected, exported);
  assert.equal(report.turns[0].status, "locally-finalized"); assert.equal(report.turns[0].deadlineElapsed, true);
  assert.ok(report.blockers.includes("phase_session_completion_time_unproved"));
  const prep = (await fixture("preparation", 5, "instruction")).exported;
  delete prep.body.activeTurn;
  Object.assign(prep.body.turns.turn, { complete: true, done: true, draft: "", timedOut: true });
  assert.equal(inspect(prep).turns[0].status, "exhausted");
});

test("the real shared-turn caller interrupted after durable generation exports an unresolved step, not permission to replay", async (t) => {
  let dbCalls = 0, networkCalls = 0, generations = 0;
  t.mock.method(Pool.prototype, "query", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.connect);
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("Network forbidden"); });
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  const submission = { kind: "text" as const, text: "SIMULACIÓN LOCAL: afirmación para verificar.", resolvedLanguage: "es" };
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission, models: modelSnapshot(DEFAULT_MODELS) };
  const reader = new SourceService("fixture", "es", { operations, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-export-v1",
    translate: async input => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async () => { networkCalls++; throw new Error("Source acquisition forbidden"); } });
  const spec = { kind: "intake" as const };
  const underlying = createMockSeat({ spec, record: [], submission, shared: true }, false).model;
  const model = new MockLanguageModelV4({ doGenerate: async options => { generations++; return underlying.doGenerate(options); } });
  await assert.rejects(advanceSharedTurn("fixture", { submission, today: "2026-11-05", language: "es", models: DEFAULT_MODELS, simulated: true }, spec, [], 0, {
    record, reader, artifacts, repository, model, prepare: async () => "Análisis de simulación.", activity: async () => {},
    audit: async () => { throw new Error("Interrupted after durable generation before message checkpoint"); },
  }), /Interrupted after durable generation/);
  const key = "intake:judge:decision", row = (await repository.load("fixture", key))!;
  const saved = Object.values(row.body.turns)[0];
  assert.equal(row.body.activeTurn, undefined); assert.equal(saved.steps, 0);
  assert.ok(saved.inFlightStep); assert.ok(Object.keys(saved.results).length > 0);
  assert.ok((await artifacts.read("fixture")).size > 0);
  assert.ok((await operations.list("fixture")).some(operation => operation.stage === "decision-generation" && operation.status === "ready"));
  // Like JSONB, an offline exporter transports JSON, not live SDK objects.
  const exported: PhaseSessionExport = roundtrip({ schemaVersion: 1, kind: "phase_session_offline_export",
    origin: { caseId: "fixture", pipeline: 2, generation: 0, runId: "fixture-run", deploymentId: "fixture-deployment",
      sessionId: row.body.id, sessionKey: key, storageKey: key }, revision: row.revision, body: row.body });
  const before = JSON.stringify(exported), report = inspect(exported);
  assert.equal(report.turns[0].status, "unresolved");
  assert.deepEqual(report.turns[0].unresolved, ["model_step_in_flight"]);
  assert.equal(report.continuationEnabled, false); assert.equal(phaseSessionExportPreflight().state, "blocked");
  assert.equal(JSON.stringify(exported), before); assert.deepEqual(await repository.load("fixture", key), row);
  assert.equal(generations, 1); assert.equal(dbCalls, 0); assert.equal(networkCalls, 0);
});

test("schema parsing must not omit record keys or accept an absent tool result output", async () => {
  const { exported } = await fixture();
  mutateTurn(exported, saved => { saved.results = { "tool-id": { input: "[]", output: null } }; });
  assert.equal(inspect(exported).state, "verified-offline");
  const absent = roundtrip(exported);
  Reflect.deleteProperty(absent.body.turns.turn.results["tool-id"], "output");
  assert.throws(() => inspect(absent), /output/);
  const special = roundtrip(exported);
  special.body.model.providerOptions = JSON.parse('{"__proto__":{"value":"must not disappear"}}');
  assert.throws(() => inspect(special), /schema parsing changed JSON data/);
});

test("corrupt turn links, offsets, unknown fields, markers and cursor are rejected even with a fresh consistency hash", async () => {
  const { exported } = await fixture();
  for (const change of [
    (value: PhaseSessionExport) => { value.body.activeTurn!.steps = 1; },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.id = "other"; }); },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.start = 99; }); },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.inFlightStep = "decision:other:turn:0"; }); },
    (value: PhaseSessionExport) => { mutateTurn(value, saved => { saved.answer = { step: 0, output: {} }; }); },
    (value: PhaseSessionExport) => { value.body.cursor = -1; },
    (value: PhaseSessionExport) => { Object.assign(value.body, { unknownVersionField: true }); },
    (value: PhaseSessionExport) => { value.body.tools = "not JSON"; },
  ]) { const other = roundtrip(exported); change(other); assert.throws(() => inspect(other)); }
});

test("context limit counts serialized UTF-16 including escapes, not UTF-8 bytes or raw content", async () => {
  const { exported } = await fixture();
  exported.body.messages.push({ role: "assistant", content: "" });
  const overhead = JSON.stringify(exported.body.messages).length;
  exported.body.messages.at(-1)!.content = "x".repeat(2_000_000 - overhead);
  assert.equal(JSON.stringify(exported.body.messages).length, 2_000_000);
  assert.equal(inspect(exported).state, "verified-offline");
  exported.body.messages.at(-1)!.content += "x";
  assert.throws(() => inspect(exported), /context limit/);
  exported.body.messages.at(-1)!.content = "😀".repeat(500_000);
  assert.ok(Buffer.byteLength(JSON.stringify(exported.body.messages)) > 2_000_000);
  assert.equal(inspect(exported).state, "verified-offline");
  exported.body.messages.at(-1)!.content = "\n".repeat(1_000_000);
  assert.throws(() => inspect(exported), /context limit/);
});

test("malformed JSON is rejected before getters/proxies/toJSON and offline bounds fail closed", async () => {
  const { exported } = await fixture();
  const expected = expectation(exported);
  let accesses = 0;
  const getter = Object.defineProperty({}, "origin", { enumerable: true, get() { accesses++; return exported.origin; } });
  const proxy = new Proxy(exported, { get() { accesses++; throw new Error("proxy trap"); }, ownKeys() { accesses++; return []; } });
  const toJSON = { ...exported, toJSON() { accesses++; return exported; } };
  const hidden = Object.defineProperty(roundtrip(exported), "hidden", { value: true });
  const sparse = roundtrip(exported); sparse.body.messages = Array(1);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [getter, proxy, toJSON, hidden, sparse, cycle, NaN, undefined]) assert.throws(() => verifyPhaseSessionExport(expected, value));
  assert.equal(accesses, 0);
  let deep: unknown = "leaf"; for (let i = 0; i < 34; i++) deep = { child: deep };
  assert.throws(() => verifyPhaseSessionExport(expected, deep), /offline JSON bounds/);
  assert.throws(() => verifyPhaseSessionExport(expected, { large: "x".repeat(8_000_001) }), /offline JSON bounds/);
  assert.throws(() => verifyPhaseSessionExport(expected, Array(100_001).fill(null)), /dense JSON arrays/);
});

test("legacy replay preserves prefix, deadline and CAS behavior after local interruption; no runtime imports the adapter", async () => {
  const { session, repository, configuration } = await fixture();
  const original = JSON.stringify(session.state.messages), deadline = session.state.turns.turn.expiresAt;
  const stale = await PhaseSession.open("fixture", configuration, repository);
  await session.append([{ role: "assistant", content: "durable partial reply" }]);
  await assert.rejects(stale.append([{ role: "assistant", content: "stale reply" }]), /Concurrent phase-session checkpoint/);
  const reopened = await PhaseSession.open("fixture", configuration, repository);
  await reopened.begin("turn", [], "replacement task must not enter messages", 1);
  assert.equal(reopened.state.turns.turn.expiresAt, deadline);
  assert.equal(JSON.stringify(reopened.state.messages.slice(0, -1)), original);
  assert.equal(reopened.state.messages.at(-1)!.content, "durable partial reply");
  const source = readFileSync(new URL("./phase-session-export.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from|import\s*\()\s*["'][^"']*(?:phase-session\.ts|store\.ts|workflow|sandbox|blob\.ts)/);
  assert.doesNotMatch(source, /\b(?:fetch|Date\.now|savePhaseCheckpoint|loadPhaseCheckpoint|generateText)\s*\(/);
  const cursor = readFileSync(new URL("./phase-session-cursor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cursor, /(?:from|import\s*\()\s*["'][^"']*(?:phase-session\.ts|store\.ts|workflow|sandbox|blob\.ts)/);
  assert.doesNotMatch(cursor, /\b(?:fetch|Date\.now|savePhaseCheckpoint|loadPhaseCheckpoint|generateText)\s*\(/);
  // Exactly these two standalone offline files may compose. No runtime file
  // may import either adapter; this is not an exception for production callers.
  const offline = new Set(["./phase-session-export.ts", "./phase-session-cursor.ts"].map(path => new URL(path, import.meta.url).href));
  function scan(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { scan(new URL(`${entry.name}/`, directory)); continue; }
      const path = new URL(entry.name, directory);
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || offline.has(path.href)) continue;
      const code = readFileSync(path, "utf8");
      assert.equal(code.includes("phase-session-export"), false, entry.name);
      assert.equal(code.includes("phase-session-cursor"), false, entry.name);
    }
  }
  scan(new URL("../", import.meta.url));
});
