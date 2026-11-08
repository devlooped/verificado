import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { COUNSEL, type Counsel, type RecordedEvent } from "../domain/court.ts";
import { CONTINUATION_ENABLED, continuationHash } from "../domain/continuation.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { nativeResearchTools } from "../instruction/native-research.ts";
import { createQuickMockModel } from "./mock.ts";
import { courtModel, modelEffort } from "./models.ts";
import { quickAnswer, quickVote, type QuickPlayDependencies } from "./quick-play.ts";
import { holdQuickSession, type QuickBench } from "./quick.ts";
import { quickAnalystPreflight, verifyQuickAnalystResults, type QuickAnalystExpectation, type QuickAnalystResults } from "./quick-analyst-results.ts";

const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown) => value as Record<string, any>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
function expectation(exported: QuickAnalystResults): QuickAnalystExpectation {
  return { origin: clone(exported.origin), inputHash: continuationHash(exported.origin), evidenceHash: continuationHash(exported) };
}

async function fixture(): Promise<QuickAnalystResults> {
  const origin: QuickAnalystResults["origin"] = {
    caseId: "local-quick", runId: "local-run", deploymentId: "local-deployment", pipeline: 5, language: "es", simulated: true,
    submission: { kind: "text", check: "quick", text: "La pobreza bajó al 31,6 %.", resolvedLanguage: "es" },
    models: { judge: courtModel("anthropic/fixture-judge", "high"), grok: courtModel("spacexai/fixture", "high"), gemini: courtModel("google/fixture", "high"),
      claude: courtModel("anthropic/fixture", "high"), chatgpt: courtModel("openai/fixture", "high") },
  };
  const artifacts = new MemoryArtifactStore();
  const audit = new Map<string, unknown>();
  const journals = new Map<string, QuickAnalystResults["analysts"][number]["answer"]["journal"]>();
  const deps = (kind: "answer" | "vote"): QuickPlayDependencies => ({ artifacts, model: createQuickMockModel(kind),
    audit: async (_caseId, key, body) => { audit.set(key, json(body)); }, getImage: async () => { throw new Error("Unexpected image read"); },
  });
  const args = (by: Counsel, attempt: number) => ({ caseId: origin.caseId, submission: origin.submission, language: origin.language, model: origin.models[by], by, attempt, simulated: true });
  const events: RecordedEvent[] = [];
  const bench: QuickBench = {
    submission: origin.submission, simulated: true,
    models: { judge: origin.models.judge.id, counsel: Object.fromEntries(COUNSEL.map(by => [by, origin.models[by].id])) as QuickBench["models"]["counsel"] },
    efforts: { judge: null, counsel: { grok: null, gemini: null, claude: null, chatgpt: null } },
    answer: async (by, attempt) => {
      const output = await quickAnswer(origin.caseId, origin.submission, origin.language, origin.models[by], by, attempt, deps("answer"));
      assert.ok(!("error" in output));
      journals.set(`${by}:answer`, { id: `sdk-fixture-answer-${by}`, method: "answerQuick", state: "completed", arguments: args(by, attempt), output });
      return output;
    },
    vote: async (by, answer, attempt) => {
      const output = await quickVote(origin.caseId, origin.submission, origin.language, origin.models[by], by, answer, attempt, undefined, deps("vote"));
      assert.ok(!("error" in output));
      journals.set(`${by}:vote`, { id: `sdk-fixture-vote-${by}`, method: "voteQuick", state: "completed", arguments: { ...args(by, attempt), answer }, output });
      return output;
    },
    tiebreak: async () => { throw new Error("Unexpected tie-break"); },
    commit: async batch => {
      events.push(...batch);
      if (batch.some(event => event.type === "content_vote")) throw new Error("fixture stopped after fully published round");
    },
  };
  await assert.rejects(holdQuickSession(bench), /fully published round/);
  const files = await artifacts.read(origin.caseId);
  const analysts = COUNSEL.map(by => {
    const step = (kind: "answer" | "vote") => {
      const root = `quick/${by}/${kind}-0`;
      const parse = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)!));
      const key = `quick:${by}:${kind}:0`;
      return { journal: journals.get(`${by}:${kind}`)!, request: { path: `${root}/request.json`, body: parse(`${root}/request.json`) },
        result: { path: `${root}/result.json`, body: parse(`${root}/result.json`) }, audit: { key, body: audit.get(key)! } };
    };
    return { by, answer: step("answer"), vote: step("vote") };
  });
  return { schemaVersion: 1, origin, analysts, events, operationCoverage: "unproved", unresolvedOperations: [] };
}

test("real simulated Quick calls and orchestration yield a complete offline evidence cursor", async () => {
  const exported = await fixture(), pins = expectation(exported);
  const before = clone({ exported, pins });
  const cursor = verifyQuickAnalystResults(pins, exported);
  assert.equal(cursor.status, "verified-offline");
  assert.equal(cursor.nextSeq, 10);
  assert.equal(cursor.continuationEnabled, false);
  assert.equal(cursor.prefixHash, continuationHash(exported.events));
  assert.deepEqual(cursor.evidence, exported, "IDs, outputs, messages, usage, events, dates and provenance are retained");
  for (let i = 0; i < 3; i++) assert.deepEqual(verifyQuickAnalystResults(pins, exported), cursor);
  assert.deepEqual({ exported, pins }, before);
  object(cursor.evidence.analysts[0].answer.journal.output).text = "changed returned copy";
  assert.deepEqual({ exported, pins }, before);
  assert.equal(object(exported.analysts[0].answer.audit.body).data.sequence, 0);
  assert.equal(object(exported.analysts[0].vote.audit.body).data.sequence, 2);
  assert.equal(object(exported.events[1]).modelId, "court-fixture");
  assert.equal(object(exported.analysts[0].answer.audit.body).effort, "high");
});

test("offline verification accepts historical and configured output caps without relying on the current environment", async () => {
  const exported = await fixture();
  const historical = clone(exported);
  for (const analyst of historical.analysts) for (const step of [analyst.answer, analyst.vote]) delete object(step.request.body).maxOutputTokens;
  assert.equal(verifyQuickAnalystResults(expectation(historical), historical).status, "verified-offline");

  const configured = clone(exported);
  object(configured.analysts[0].answer.request.body).maxOutputTokens = 12_345;
  assert.equal(verifyQuickAnalystResults(expectation(configured), configured).status, "verified-offline");
  assert.throws(() => verifyQuickAnalystResults(expectation(exported), configured), /hash mismatch/);
  for (const value of [0, -1, 1.5, null, "32000", Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = clone(exported);
    object(invalid.analysts[0].vote.request.body).maxOutputTokens = value;
    assert.throws(() => verifyQuickAnalystResults(expectation(invalid), invalid));
  }
  const unexpected = clone(exported);
  object(unexpected.analysts[0].answer.request.body).unrelatedOption = true;
  assert.throws(() => verifyQuickAnalystResults(expectation(unexpected), unexpected), /request prompt/);
});

test("synthetic live-contract export preserves native tools, options, sources and untrimmed vote", async () => {
  const exported = await fixture();
  exported.origin.simulated = false;
  const opened = object(exported.events[0]);
  delete opened.simulated;
  opened.judgeEffort = modelEffort(exported.origin.models.judge);
  for (const [index, by] of COUNSEL.entries()) {
    const analyst = exported.analysts[index], configured = exported.origin.models[by];
    opened.counselEfforts[by] = modelEffort(configured);
    const answer = object(analyst.answer.journal.output);
    answer.modelId = configured.id; answer.effort = modelEffort(configured);
    answer.sources = [{ url: `https://fixture.invalid/${by}`, title: `Source ${by}` }];
    object(analyst.answer.result.body).sources = clone(answer.sources);
    object(analyst.answer.audit.body).data.sources = clone(answer.sources);
    object(analyst.answer.request.body).tools = nativeResearchTools(configured.id, "instruction");
    for (const step of [analyst.answer, analyst.vote]) object(step.journal.arguments).simulated = false;
    object(analyst.vote.journal.arguments).answer = clone(answer);
    Object.assign(object(exported.events[index + 1]), { modelId: answer.modelId, effort: answer.effort, sources: clone(answer.sources) });
    const ballot = object(analyst.vote.journal.output);
    ballot.rationale = "  Razonamiento completo conservado.  ";
    object(analyst.vote.result.body).output.rationale = ballot.rationale;
    object(exported.events[index + 5]).rationale = ballot.rationale.trim();
    // Parallel completion timestamps are not required to be monotonic by seq.
    answer.at = `2026-11-07T12:00:0${3 - index}.000Z`;
    object(analyst.answer.result.body).at = answer.at;
    object(analyst.answer.audit.body).at = answer.at;
    object(exported.events[index + 1]).at = answer.at;
    object(analyst.vote.journal.arguments).answer = clone(answer);
  }
  const cursor = verifyQuickAnalystResults(expectation(exported), exported);
  assert.deepEqual(cursor.evidence, exported);
  assert.equal(object(cursor.evidence.analysts[0].vote.journal.output).rationale, "  Razonamiento completo conservado.  ");
  assert.equal(object(cursor.evidence.events[5]).rationale, "Razonamiento completo conservado.");
});

test("every partial publication and missing result blocks, without reconstructing from counts", async () => {
  const exported = await fixture();
  for (let length = 0; length < 9; length++) {
    const changed = clone(exported); changed.events.length = length;
    assert.throws(() => verifyQuickAnalystResults(expectation(changed), changed));
  }
  for (const mutation of [
    (e: QuickAnalystResults) => { e.analysts.pop(); },
    (e: QuickAnalystResults) => { e.analysts[0].answer.journal.output = null; },
    (e: QuickAnalystResults) => { e.analysts[0].vote.result.body = null; },
    (e: QuickAnalystResults) => { e.analysts[0].answer.audit.body = null; },
    (e: QuickAnalystResults) => { e.analysts[0].answer.request.body = null; },
    (e: QuickAnalystResults) => { object(e).completedAnalysts = 4; e.analysts = []; },
    (e: QuickAnalystResults) => { object(e.events[5]).type = "absence"; },
    (e: QuickAnalystResults) => { e.events.push(clone(e.events[8])); },
  ]) {
    const changed = clone(exported); mutation(changed);
    assert.throws(() => verifyQuickAnalystResults(expectation(changed), changed));
  }
});

test("uncertain operations, non-success results, unsupported phases and incompatible origins block", async () => {
  const exported = await fixture();
  const mutations: Array<(e: QuickAnalystResults) => void> = [
    ...["running", "pending", "failed", "uncertain", "expired", "cancelled"].map(state => (e: QuickAnalystResults) => { object(e.analysts[0].answer.journal).state = state; }),
    e => { e.unresolvedOperations.push("provider-call-uncertain"); },
    e => { object(e).operationCoverage = "complete"; },
    ...[1, 2, 3, 4].map(pipeline => (e: QuickAnalystResults) => { object(e.origin).pipeline = pipeline; }),
    e => { object(e.origin.submission).identifyClaims = true; },
    e => { object(e.origin.submission).check = "expert"; },
    e => { object(e.origin.submission).kind = "link"; },
    e => { object(e.origin.submission).kind = "image"; },
    e => { object(e.analysts[0].answer.journal).method = "advanceShared"; },
    e => { e.origin.language = "en"; },
    e => { object(e.analysts[0].answer.result.body).finishReason = "length"; },
    e => { object(e.analysts[0].answer.result.body).error = "uncertain paid call"; },
    e => { object(e.analysts[0].vote.result.body).error = "unparseable vote"; },
    e => { object(e.analysts[0].vote.journal.output).rationale = "short"; },
    e => { object(e.analysts[0].answer.journal.output).text = ""; },
  ];
  for (const mutate of mutations) {
    const changed = clone(exported); mutate(changed);
    assert.throws(() => verifyQuickAnalystResults(expectation(changed), changed));
  }
  for (const field of ["caseId", "runId", "deploymentId", "language"] as const) {
    const changed = clone(exported); changed.origin[field] = "different";
    assert.throws(() => verifyQuickAnalystResults(expectation(exported), changed));
  }
  const changed = clone(exported); changed.origin.models.grok.providerOptions = { xai: { reasoningEffort: "low", otherOption: "changed" } };
  assert.throws(() => verifyQuickAnalystResults(expectation(changed), changed));
});

test("rehashing never repairs request, journal, audit, model, path, ID or event collisions", async () => {
  const exported = await fixture();
  const mutations: Array<(e: QuickAnalystResults) => void> = [
    e => { [e.analysts[0], e.analysts[1]] = [e.analysts[1], e.analysts[0]]; },
    e => { e.analysts[1].answer.journal.id = e.analysts[0].vote.journal.id; },
    e => { e.analysts[0].answer.journal.id += " "; },
    e => { e.analysts[0].answer.request.path = e.analysts[1].answer.request.path; },
    e => { e.analysts[0].vote.result.path = "quick/grok/vote-1/result.json"; },
    e => { object(e.analysts[0].answer.journal.arguments).attempt = 1; },
    e => { object(e.analysts[0].vote.journal.arguments).retry = { error: "unknown call", text: "" }; },
    e => { object(e.analysts[0].vote.journal.arguments).answer.text = "different response"; },
    e => { object(e.analysts[0].answer.request.body).system = "different prompt"; },
    e => { object(e.analysts[0].answer.request.body).tools = [{}]; },
    e => { object(e.analysts[0].vote.request.body).reasoning = "high"; },
    e => { object(e.analysts[0].vote.request.body).messages[1].content = "changed conversation"; },
    e => { object(e.analysts[0].vote.request.body).output = {}; },
    e => { object(e.analysts[0].answer.journal.output).modelId = "different/model"; },
    e => { object(e.analysts[0].answer.journal.output).effort = "high"; },
    e => { object(e.analysts[0].answer.audit.body).data.sequence = 2; },
    e => { object(e.analysts[0].vote.audit.body).data.sessionId = "quick:gemini"; },
    e => { object(e.analysts[0].vote.audit.body).id = "different-audit"; },
    e => { e.analysts[0].vote.audit.key = "different-key"; },
    e => { object(e.analysts[0].answer.audit.body).modelId = "different/model"; },
    e => { object(e.analysts[0].answer.result.body).sources = [{ url: "https://fixture.invalid/extra" }]; },
    e => { object(e.events[0]).judgeModel = "different/judge"; },
    e => { object(e.events[0]).judgeEffort = "high"; },
    e => { object(e.events[1]).seq = 3; },
    e => { object(e.events[1]).at = "2026-11-07T01:00:00.000Z"; },
    e => { object(e.events[1]).evidenceRunId = "invented-provenance"; },
    e => { object(e.events[5]).rationale = "Different full rationale"; },
  ];
  for (const mutate of mutations) {
    const changed = clone(exported); mutate(changed);
    assert.throws(() => verifyQuickAnalystResults(expectation(changed), changed));
  }
  const pins = expectation(exported); pins.evidenceHash = "0".repeat(64);
  assert.throws(() => verifyQuickAnalystResults(pins, exported), /hash mismatch/);
  const badInputPin = expectation(exported); badInputPin.inputHash = "0".repeat(64);
  assert.throws(() => verifyQuickAnalystResults(badInputPin, exported), /hash mismatch/);
});

test("malformed, sparse, accessor and oversized JSON blocks before hashing or normalization", async () => {
  const exported = await fixture(), pins = expectation(exported);
  const malformed = [undefined, NaN, Infinity, 1n, new Date(), new Uint8Array([1]), Object.create(null), () => 1];
  const sparse = clone(exported); object(sparse.analysts[0].answer.result.body).messages = Array(1);
  malformed.push(sparse);
  const arrayExtra = clone(exported); object(object(arrayExtra.analysts[0].answer.result.body).messages).extra = true; malformed.push(arrayExtra);
  const symbol = clone(exported); Object.defineProperty(symbol, Symbol("hidden"), { value: true }); malformed.push(symbol);
  const hidden = clone(exported); Object.defineProperty(hidden, "hidden", { value: true }); malformed.push(hidden);
  const accessor = clone(exported); Object.defineProperty(accessor, "hidden", { enumerable: true, get: () => { throw new Error("getter must not run"); } }); malformed.push(accessor);
  const cyclic = clone(exported); object(cyclic).cycle = cyclic; malformed.push(cyclic);
  const oversized = clone(exported); object(oversized.analysts[0].answer.result.body).text = "x".repeat(2_000_001); malformed.push(oversized);
  const deep = clone(exported); let nested: any = {}; for (let i = 0; i < 34; i++) nested = { nested }; object(deep.analysts[0].answer.result.body).usage = nested; malformed.push(deep);
  const many = clone(exported); object(many.analysts[0].answer.result.body).messages = Array(100_001).fill(null); malformed.push(many);
  for (const value of malformed) assert.throws(() => verifyQuickAnalystResults(pins, value));
  assert.throws(() => verifyQuickAnalystResults(Array(1), exported), /dense JSON/);
});

test("nested malformed evidence and pins fail closed without getters, proxy traps or normalization", async t => {
  const exported = await fixture(), pins = expectation(exported);
  let effects = 0;
  const forbidden = () => { effects++; throw new Error("unexpected malformed Quick effect"); };
  t.mock.method(globalThis, "fetch", forbidden); t.mock.method(Date, "now", forbidden);
  const mutations: Array<(e: QuickAnalystResults, p: QuickAnalystExpectation) => object> = [
    ...[Array(1), [1, , 2], { nested: undefined }, { nested: 1n }, { nested: NaN }, { nested: Infinity }, { nested: Symbol("value") }, { nested: () => 1 }].map(value => (e: QuickAnalystResults) => {
      const body = object(e.analysts[0].answer.result.body); body.messages = value; return body;
    }),
    ...["extra", "01", Symbol("hidden")].map(key => (e: QuickAnalystResults) => Object.defineProperty(object(e.analysts[0].answer.result.body).messages, key, { value: true, enumerable: true })),
    e => Object.defineProperty(object(e.analysts[0].answer.result.body).messages, "hidden", { value: true }),
    ...["hidden", Symbol("hidden")].map(key => (e: QuickAnalystResults) => Object.defineProperty(e.analysts[0].answer.result.body, key, { value: true })),
    e => Object.defineProperty(e.analysts[0].answer.result.body, "text", { enumerable: true, get: forbidden }),
    e => Object.defineProperty(e.analysts[0].answer.result.body, "toJSON", { get: forbidden }),
    e => Object.defineProperty(object(e.analysts[0].vote.request.body).output, "~standard", { value: { validate: forbidden } }),
    e => { const body = object(e.analysts[0].answer.result.body); body.toJSON = forbidden; return body; },
    e => { const body = object(e.analysts[0].answer.result.body); body.cycle = body; return body; },
    e => { e.analysts[0].answer.result.body = new Proxy({}, { getPrototypeOf: forbidden, ownKeys: forbidden, get: forbidden }); return e.analysts[0].answer.result; },
    (_e, p) => Object.defineProperty(p.origin.models.judge, Symbol("hidden"), { value: true }),
    (_e, p) => Object.defineProperty(p, "inputHash", { enumerable: true, get: forbidden }),
    (_e, p) => { p.origin.models.judge = new Proxy(p.origin.models.judge, { getPrototypeOf: forbidden, ownKeys: forbidden, get: forbidden }); return p.origin.models; },
  ];
  for (const mutate of mutations) {
    const e = clone(exported), p = clone(pins), target = mutate(e, p);
    Object.freeze(target);
    const before = Object.getOwnPropertyDescriptors(target);
    assert.throws(() => verifyQuickAnalystResults(p, e));
    const diagnosis = quickAnalystPreflight(p, e);
    assert.equal(diagnosis.state, "blocked"); assert.equal(diagnosis.continuationEnabled, false);
    assert.deepEqual(diagnosis.blockers, ["quick_analyst_evidence_invalid", "historical_inactivity_unproved", "historical_operation_coverage_unproved", "artifact_bytes_and_export_provenance_unproved", "continuation_disabled"]);
    assert.ok(!("analystResults" in diagnosis));
    assert.deepEqual(Object.getOwnPropertyDescriptors(target), before);
  }
  assert.equal(effects, 0);
  assert.deepEqual(expectation(exported), pins, "independent unmodified fixture hashes remain stable");
});

test("valid and blocked preflights are deterministic, private, effect-free and never authorize continuation", async () => {
  const exported = await fixture(), pins = expectation(exported), before = clone({ exported, pins });
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("No remote reader permitted"); });
  const clockMock = mock.method(Date, "now", () => { throw new Error("No clock permitted"); });
  try {
    const valid = quickAnalystPreflight(pins, exported);
    assert.equal(valid.state, "blocked"); assert.equal(valid.continuationEnabled, false);
    assert.ok("analystResults" in valid);
    assert.deepEqual(quickAnalystPreflight(pins, exported), valid);
    const invalid = clone(exported); invalid.analysts[0].answer.journal.output = { error: "PRIVATE_PROVIDER_SECRET" };
    const blocked = quickAnalystPreflight(pins, invalid);
    assert.equal(blocked.state, "blocked"); assert.equal(blocked.continuationEnabled, false);
    assert.ok(!("analystResults" in blocked));
    assert.ok(!JSON.stringify(blocked).includes("PRIVATE_PROVIDER_SECRET"));
    assert.deepEqual({ exported, pins }, before);
    assert.equal(fetchMock.mock.callCount(), 0); assert.equal(clockMock.mock.callCount(), 0);
    assert.equal(CONTINUATION_ENABLED, false);
  } finally { fetchMock.mock.restore(); clockMock.mock.restore(); }
  const source = readFileSync(new URL("./quick-analyst-results.ts", import.meta.url), "utf8");
  const runtimeImports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map(match => match[1]);
  assert.deepEqual(runtimeImports, ["node:util", "zod", "../domain/court.ts", "../domain/continuation.ts", "../instruction/native-research.ts", "./models.ts", "./quick.ts"]);
  assert.doesNotMatch(source, /\b(?:fetch|generateText|loadPhaseCheckpoint|savePhaseCheckpoint|saveEvents|saveCaseAuditRecord|caseArtifactStore|PhaseSession|Sandbox)\s*\(/);
});
