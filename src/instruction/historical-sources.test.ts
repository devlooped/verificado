import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { caseArtifactStore } from "../evidence/blob.ts";
import { continuationHash } from "../domain/continuation.ts";
import { inspectSource } from "../../scripts/continuation-inventory.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { historicalSourcePreflight, verifyHistoricalSourceBatch, type HistoricalArtifact, type HistoricalSourceBatch } from "./historical-sources.ts";

const at = "2026-11-07T12:00:00.000Z";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: string) => new TextEncoder().encode(value);
type Operation = HistoricalSourceBatch["operations"]["records"][number]["body"];

// No SourceService, download, extraction or model invocation constructs this
// fixture. Every byte/result is synthetic; it is not an export of AT-185-GA.
function fixture(pipeline: 3 | 4 | 5 = 5) {
  const origin = { caseId: "synthetic-33-not-AT185", check: "expert" as const, pipeline, runId: "fixture-run", deploymentId: "fixture-deployment", language: "es", models: Object.fromEntries(["judge", "counsel.grok", "counsel.gemini", "counsel.claude", "counsel.chatgpt"].map(role => [role, { id: `fixture/${role}`, effort: role === "judge" ? null : "high" }])) };
  const urls = Array.from({ length: 33 }, (_, i) => `https://fixture.invalid/source/${i}`);
  const input: HistoricalSourceBatch = {
    format: "historical-source-batch/v1", origin, caseStatus: "failed", urls,
    inputHash: continuationHash({ origin, urls }),
    operations: { format: "source-operations/v1", origin: structuredClone(origin), records: [] },
    aliases: { format: "source-aliases/v1", origin: structuredClone(origin), records: [] },
    artifacts: [], journal: { format: "fetchProposals-results/v1", origin: structuredClone(origin), batches: [] },
  };
  const artifacts: HistoricalArtifact[] = [];
  const expected: Array<{ url: string; sourceId: string } | { url: string; error: string }> = [];
  function addOperation(key: string, stage: Operation["stage"], value: { result: unknown } | { error: string }) {
    const body: Operation = { key, stage, status: "error" in value ? "failed" : "ready", at, owner: "fixture-owner", expiresAt: "2000-01-01T00:00:00.000Z", recoveries: [], ...value };
    input.operations.records.push({ body, hash: continuationHash(body) });
  }
  function addFile(path: string, content: string) {
    const bytes = encode(content);
    artifacts.push({ path, bytes }); input.artifacts.push({ path, hash: hash(bytes) });
  }
  for (const [i, url] of urls.entries()) {
    const sourceId = `src_${hash(url).slice(0, 24)}`, root = `instruction/sources/${sourceId}`;
    input.aliases.records.push({ url, sourceId });
    if ([2, 11, 20, 32].includes(i)) {
      addOperation(`acquisition:${sourceId}`, "acquisition", { error: `fixture_http_${400 + i}: exact synthetic failure ${i}` });
      expected.push({ url, error: "source_failed" });
      continue;
    }
    const raw = `Original sintético ${i}; no es un documento real.`, rawHash = hash(raw);
    const acquisition = { sourceId, url, finalUrl: url, at, originalPath: `${root}/original.bin`, rawHash, contentType: "text/plain", extension: "txt" };
    addFile(acquisition.originalPath, raw);
    addOperation(`acquisition:${sourceId}`, "acquisition", { result: acquisition });
    const extractionKey = `extraction:${hash(JSON.stringify([rawHash, "markdown-blocks-v1", "txt"]))}`;
    const path = `instruction/operations/${hash(extractionKey)}/extracted.md`;
    const prefix = "[p.1]\n\n[p1:b1]\n\n", passage = `Pasaje sintético ${i}; preserves 😀 and UTF-16 offsets.`;
    const markdown = prefix + passage + "\n\n";
    const document = { title: i % 2 ? `Título ${i}` : "", path, hash: hash(markdown), blocks: [{ id: "p1:b1", page: 1, offset: prefix.length, length: passage.length }], tool: "text-markdown", confidence: 1 };
    addFile(path, markdown);
    addOperation(extractionKey, "extraction", { result: document });
    const source = { schemaVersion: 3, sourceId, acquisition, extraction: { version: "markdown-blocks-v1", path, hash: document.hash, tool: document.tool, confidence: document.confidence }, document: { ...document, title: document.title || url, path: `${root}/extracted.md` } };
    const json = JSON.stringify(source);
    addFile(source.document.path, markdown); addFile(`${root}/source.json`, json);
    const canonicalKey = `canonical:${hash(JSON.stringify([sourceId, document.hash, document.title, "original"]))}`;
    addOperation(canonicalKey, "canonical", { result: { path: `${root}/source.json`, hash: hash(json) } });
    expected.push({ url, sourceId });
  }
  const batches = Math.ceil(urls.length / 4);
  for (let i = 0; i < batches; i++) {
    const slice = urls.slice(i * 4, (i + 1) * 4), result = expected.slice(i * 4, (i + 1) * 4);
    input.journal!.batches.push({ step: "fetchProposals", stepId: `fixture-step-${i + 1}`, ordinal: i + 1, completedAt: at, urls: slice, result, resultHash: continuationHash(result), inputHash: continuationHash({ caseId: origin.caseId, language: origin.language, urls: slice, simulated: false, ...(pipeline === 3 ? {} : { batch: i + 1, batches }) }) });
  }
  const expectation = { origin: structuredClone(origin), inputHash: input.inputHash, evidenceHash: continuationHash(input) };
  return { origin: structuredClone(origin), expectation, input, artifacts, expected };
}
type Fixture = ReturnType<typeof fixture>;
const verify = (f: Fixture) => verifyHistoricalSourceBatch(f.expectation, f.input, f.artifacts);
const rehashOperations = (f: Fixture) => f.input.operations.records.forEach(item => { item.hash = continuationHash(item.body); });
function blocked(f: Fixture, code?: string) {
  const result = verify(f);
  assert.equal(result.state, "blocked");
  if (result.state === "blocked" && code) assert.equal(result.code, code);
  assert.deepEqual(Object.keys(result).sort(), ["code", "state"], "no partial URL/body/result escapes a failed validation");
}

test("33 URLs/four exact failures verify offline for concrete 3/4/5 contracts with or without journal; preflight still blocks", () => {
  for (const pipeline of [3, 4, 5] as const) for (const journal of [true, false]) {
    const f = fixture(pipeline);
    if (!journal) { f.input.journal = null; f.expectation.evidenceHash = continuationHash(f.input); }
    const before = structuredClone(f);
    const result = verify(f);
    if (result.state !== "verified-offline") throw new Error(result.code);
    assert.deepEqual(result.fetched, f.expected);
    assert.deepEqual(result.origin, f.origin);
    assert.equal(result.fetched.length, 33); assert.equal(result.failures.length, 4);
    assert.deepEqual(result.failures.map(item => ({ operation: item.operation, reason: item.reason, at: item.at })), f.input.operations.records.filter(item => item.body.status === "failed").map(item => ({ operation: item.body.key, reason: item.body.error, at: item.body.at })));
    assert.equal(result.resultHash, continuationHash(f.expected));
    assert.equal(result.evidenceHash, continuationHash(f.input));
    assert.equal(result.basis, journal ? "journal-and-operations" : "operations-only");
    const diagnosis = historicalSourcePreflight(f.expectation, f.input, f.artifacts);
    assert.equal(diagnosis.state, "blocked"); assert.equal(diagnosis.continuationEnabled, false);
    assert.deepEqual(diagnosis.blockers, ["historical_inactivity_unproved", "continuation_disabled"]);
    assert.deepEqual(f, before, "all supplied bytes/records/leases remain untouched");
  }
});

test("absent/corrupt journals never create URL results from progress counts or hide disagreement", () => {
  const counts = fixture(); counts.input.journal = null; counts.input.operations.records = [];
  blocked(counts, "operation_integrity");
  assert.deepEqual(verifyHistoricalSourceBatch(counts.expectation, { total: 33, failed: 4, completed: 33 }, []), { state: "blocked", code: "invalid_export" });
  for (const mutate of [
    (f: Fixture) => { f.input.journal!.batches.pop(); },
    (f: Fixture) => { f.input.journal!.batches[0].resultHash = "0".repeat(64); },
    (f: Fixture) => { const item = f.input.journal!.batches[0]; item.result[0] = { url: item.urls[0], sourceId: "src_" + "0".repeat(24) }; item.resultHash = continuationHash(item.result); },
    (f: Fixture) => { const item = f.input.journal!.batches[0]; item.result.reverse(); item.resultHash = continuationHash(item.result); },
    (f: Fixture) => { f.input.journal!.batches[0].inputHash = "0".repeat(64); },
    (f: Fixture) => { f.input.journal!.batches[0].ordinal = 2; },
    (f: Fixture) => { const item = f.input.journal!.batches[0]; item.result[2] = { url: item.urls[2], error: "different_exact_error" }; item.resultHash = continuationHash(item.result); },
  ]) { const f = fixture(); mutate(f); blocked(f, "journal_integrity"); }
  const malformed = fixture(); (malformed.input.journal as unknown) = "corrupt export";
  blocked(malformed, "invalid_export");
  const missing = fixture(); delete (missing.input as Partial<HistoricalSourceBatch>).journal;
  blocked(missing, "invalid_export");
});

test("duplicate URLs, aliases, operations, artifacts and journal steps fail closed rather than silently selecting one", () => {
  for (const mutate of [
    (f: Fixture) => { f.input.urls[1] = f.input.urls[0]; f.input.inputHash = continuationHash({ origin: f.origin, urls: f.input.urls }); },
    (f: Fixture) => { f.input.aliases.records.push(structuredClone(f.input.aliases.records[0])); },
    (f: Fixture) => { f.input.aliases.records[1].sourceId = f.input.aliases.records[0].sourceId; },
    (f: Fixture) => { f.input.operations.records.push(structuredClone(f.input.operations.records[0])); },
    (f: Fixture) => { const item = structuredClone(f.input.operations.records[0]); item.body.status = "failed"; delete item.body.result; item.body.error = "conflicting exact error"; item.hash = continuationHash(item.body); f.input.operations.records.push(item); },
    (f: Fixture) => { f.input.artifacts.push(structuredClone(f.input.artifacts[0])); },
    (f: Fixture) => { f.artifacts[1] = structuredClone(f.artifacts[0]); },
    (f: Fixture) => { f.input.journal!.batches[1].stepId = f.input.journal!.batches[0].stepId; },
  ]) { const f = fixture(); mutate(f); blocked(f, "duplicate_or_collision"); }
  const fragments = fixture(); fragments.input.urls[0] += "#part";
  blocked(fragments, "invalid_export"); // The caller must supply the exact canonical proposal URL list.
});

test("missing/changed original, extraction, canonical document and source JSON all block", () => {
  for (const index of [0, 1, 2, 3]) {
    const absent = fixture(); absent.artifacts.splice(index, 1); blocked(absent, "artifact_integrity");
    const changed = fixture(); changed.artifacts[index].bytes[0] ^= 1; blocked(changed, "artifact_integrity");
    const rehashed = fixture(); rehashed.artifacts[index].bytes[0] ^= 1; rehashed.input.artifacts[index].hash = hash(rehashed.artifacts[index].bytes); blocked(rehashed, "artifact_integrity");
  }
  const path = fixture(); path.input.artifacts[0].path = "../private-file";
  blocked(path, "artifact_integrity");
  const offset = fixture(); (offset.input.operations.records[1].body.result as { blocks: Array<{ offset: number }> }).blocks[0].offset++;
  rehashOperations(offset); blocked(offset, "artifact_integrity");
  const duplicateJson = fixture();
  const json = new TextDecoder().decode(duplicateJson.artifacts[3].bytes).replace('{"schemaVersion":3,', '{"schemaVersion":2,"schemaVersion":3,');
  duplicateJson.artifacts[3] = { ...duplicateJson.artifacts[3], bytes: encode(json) };
  duplicateJson.input.artifacts[3].hash = hash(json);
  (duplicateJson.input.operations.records[2].body.result as { hash: string }).hash = hash(json);
  rehashOperations(duplicateJson); blocked(duplicateJson, "artifact_integrity");
});

test("unresolved/expired, recovered, incomplete or unsupported operations do not become reusable", () => {
  for (const status of ["pending", "running", "uncertain"] as const) {
    const f = fixture(); f.input.journal = null; f.input.operations.records[0].body.status = status; rehashOperations(f);
    const before = structuredClone(f); blocked(f, "operation_unresolved"); assert.deepEqual(f, before);
  }
  const hashMismatch = fixture(); hashMismatch.input.operations.records[0].hash = "0".repeat(64); blocked(hashMismatch, "operation_integrity");
  const absent = fixture(); absent.input.journal = null; absent.input.operations.records.splice(6, 1); blocked(absent, "operation_integrity");
  const noReason = fixture(); delete noReason.input.operations.records.find(item => item.body.status === "failed")!.body.error; rehashOperations(noReason); blocked(noReason, "operation_integrity");
  const conflicting = fixture(); const failed = conflicting.input.operations.records.find(item => item.body.status === "failed")!; failed.body.result = { synthetic: true }; rehashOperations(conflicting); blocked(conflicting, "operation_integrity");
  const successToFailure = fixture(); const body = successToFailure.input.operations.records[0].body; body.status = "failed"; delete body.result; body.error = "contradictory failure"; rehashOperations(successToFailure); successToFailure.input.journal = null; blocked(successToFailure, "operation_integrity");
  const recovered = fixture(); recovered.input.operations.records[0].body.recoveries.push({ at, reason: "prior uncertain work" }); blocked(recovered, "invalid_export");
  const generational = fixture(); Object.assign(generational.input.operations.records[0].body, { writer: { generation: 1, runId: "other" } }); blocked(generational, "invalid_export");
  const redirect = fixture(); (redirect.input.operations.records[0].body.result as { finalUrl: string }).finalUrl = redirect.input.urls[1]; rehashOperations(redirect); blocked(redirect, "unsupported_source");
});

test("provenance, contract and exact input mismatch block even internally consistent transplanted exports", () => {
  for (const field of ["caseId", "runId", "deploymentId", "language"] as const) {
    const f = fixture(); f.input.origin[field] += "-different"; f.input.inputHash = continuationHash({ origin: f.input.origin, urls: f.input.urls }); blocked(f, "provenance_mismatch");
  }
  const transplanted = fixture(); transplanted.input.origin.caseId = "another-case"; transplanted.input.operations.origin.caseId = "another-case"; transplanted.input.aliases.origin.caseId = "another-case"; transplanted.input.journal!.origin.caseId = "another-case"; transplanted.input.inputHash = continuationHash({ origin: transplanted.input.origin, urls: transplanted.input.urls }); blocked(transplanted, "provenance_mismatch");
  const models = fixture(); models.input.operations.origin.models.judge.id = "fixture/different-model"; blocked(models, "provenance_mismatch");
  const inputHash = fixture(); inputHash.input.inputHash = "0".repeat(64); blocked(inputHash, "input_mismatch");
  for (const pipeline of [1, 2, 6]) {
    const f = fixture(); Object.assign(f.input.origin, { pipeline }); blocked(f, "invalid_export");
  }
  const quick = fixture(); Object.assign(quick.input.origin, { check: "quick" }); blocked(quick, "invalid_export");
  const noCheck = fixture(); delete (noCheck.input.origin as Partial<HistoricalSourceBatch["origin"]>).check; blocked(noCheck, "invalid_export");
  const unsupported = fixture(); Object.assign(unsupported.input, { format: "unknown-format" }); blocked(unsupported, "invalid_export");
  const lostField = fixture(); Object.assign(lostField.input, { silentlyLost: undefined }); blocked(lostField, "invalid_export");
  const booleanProof = fixture(); Object.assign(booleanProof.input, { inactive: true, cancelled: true, leaseExpired: true });
  const diagnosis = historicalSourcePreflight(booleanProof.expectation, booleanProof.input, booleanProof.artifacts);
  assert.equal(diagnosis.state, "blocked"); assert.ok(diagnosis.blockers.includes("historical_inactivity_unproved"));
});

test("independently pinned hashes reject fully rehashed evidence, changed errors and ordered URL subsets", () => {
  const error = fixture(); error.input.journal = null;
  error.expectation.evidenceHash = continuationHash(error.input);
  error.input.operations.records.find(item => item.body.status === "failed")!.body.error = "a different exact failure";
  rehashOperations(error); blocked(error, "evidence_mismatch");
  const artifact = fixture();
  const raw = encode("Another internally consistent original");
  artifact.artifacts[0] = { ...artifact.artifacts[0], bytes: raw }; artifact.input.artifacts[0].hash = hash(raw);
  const acquired = artifact.input.operations.records[0].body.result as { rawHash: string };
  acquired.rawHash = hash(raw); rehashOperations(artifact);
  blocked(artifact, "operation_integrity"); // Its downstream chain still names the old raw hash.
  const missingPin = fixture(); delete (missingPin.expectation as Partial<typeof missingPin.expectation>).evidenceHash;
  blocked(missingPin, "invalid_export");
  const pin = fixture(); pin.expectation.evidenceHash = "0".repeat(64); blocked(pin, "evidence_mismatch");
  const inputPin = fixture(); inputPin.expectation.inputHash = "0".repeat(64); blocked(inputPin, "input_mismatch");
  const reversed = fixture(); reversed.input.urls.reverse();
  reversed.input.inputHash = continuationHash({ origin: reversed.origin, urls: reversed.input.urls });
  blocked(reversed, "input_mismatch");
  const subset = fixture(); subset.input.urls.pop();
  subset.input.inputHash = continuationHash({ origin: subset.origin, urls: subset.input.urls });
  blocked(subset, "input_mismatch");
});

test("unreferenced operations, aliases and artifact bytes are not accepted as a complete batch projection", () => {
  const operation = fixture();
  const body: Operation = { key: "acquisition:unrelated", stage: "acquisition", status: "failed", error: "not part of this batch", at, recoveries: [] };
  operation.input.operations.records.push({ body, hash: continuationHash(body) });
  blocked(operation, "operation_integrity");
  const alias = fixture(); alias.input.aliases.records.push({ url: "https://fixture.invalid/extra", sourceId: "src_" + "f".repeat(24) });
  blocked(alias, "operation_integrity");
  const extra = fixture(), path = `instruction/sources/src_${"f".repeat(24)}/original.bin`, bytes = encode("unreferenced");
  extra.artifacts.push({ path, bytes }); extra.input.artifacts.push({ path, hash: hash(bytes) });
  blocked(extra, "artifact_integrity");
});

test("malformed JSON and hidden data reject before schemas, artifact reads or effects for Expert 3/4/5", t => {
  let effects = 0;
  const forbidden = () => { effects++; throw new Error("unexpected malformed-export effect"); };
  t.mock.method(globalThis, "fetch", forbidden); t.mock.method(Date, "now", forbidden);
  const mutations: Array<(f: Fixture) => object> = [
    f => { f.input.operations.records[0].body.recoveries = Array(1); return f.input.operations.records[0].body; },
    f => { f.input.journal!.batches[0].result = Array(1); return f.input.journal!.batches[0]; },
    ...["extra", "01", Symbol("hidden")].map(key => (f: Fixture) => Object.defineProperty(f.input.urls, key, { value: true, enumerable: true })),
    f => Object.defineProperty(f.input.urls, "hidden", { value: true }),
    f => Object.defineProperty(f.input.urls, "0", { enumerable: false }),
    ...["hidden", Symbol("hidden")].map(key => (f: Fixture) => Object.defineProperty(f.input.operations.records[0].body.result as object, key, { value: true })),
    ...[undefined, () => 1, 1n, Symbol("value"), NaN, Infinity, -Infinity, new Date(), Object.create(null)].map(value => (f: Fixture) => {
      f.input.operations.records[0].body.result = { nested: value }; return f.input.operations.records[0].body;
    }),
    f => Object.defineProperty(f.input, "inputHash", { enumerable: true, get: forbidden }),
    f => Object.defineProperty(f.input.operations.records[0].body.result as object, "sourceId", { enumerable: true, get: forbidden }),
    f => { f.input.operations.records[0].body.result = { toJSON: forbidden }; return f.input.operations.records[0].body; },
    f => { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; f.input.operations.records[0].body.result = cyclic; return cyclic; },
    f => { f.input.operations.records[0].body.result = new Proxy({}, { ownKeys: forbidden, getPrototypeOf: forbidden, get: forbidden }); return f.input.operations.records[0].body; },
    f => Object.defineProperty(f.expectation.origin, Symbol("hidden"), { value: true }),
    f => Object.defineProperty(f.expectation, "inputHash", { enumerable: true, get: forbidden }),
  ];
  for (const pipeline of [3, 4, 5] as const) for (const mutate of mutations) {
    const f = fixture(pipeline), target = mutate(f);
    Object.freeze(target);
    const before = Object.getOwnPropertyDescriptors(target), artifactsBefore = structuredClone(f.artifacts);
    // A rejected export must not even consult the supplied byte snapshot.
    const unreadableSnapshot = new Proxy(f.artifacts, { get: forbidden });
    assert.deepEqual(verifyHistoricalSourceBatch(f.expectation, f.input, unreadableSnapshot), { state: "blocked", code: "invalid_export" });
    const diagnosis = historicalSourcePreflight(f.expectation, f.input, unreadableSnapshot);
    assert.equal(diagnosis.state, "blocked"); assert.equal(diagnosis.continuationEnabled, false);
    assert.deepEqual(diagnosis.blockers, ["historical_inactivity_unproved", "continuation_disabled", "invalid_export"]);
    assert.deepEqual(diagnosis.sourceBatch, { state: "blocked", code: "invalid_export" });
    assert.deepEqual(Object.getOwnPropertyDescriptors(target), before);
    assert.deepEqual(f.artifacts, artifactsBefore);
  }
  assert.equal(effects, 0, "no getter/proxy/toJSON, clock, fetch or snapshot read ran");
});

test("preflight and adapter have no IO/effect dependencies, invoke zero effect mocks and do not modify leases or source data", t => {
  let effects = 0;
  const forbidden = () => { effects++; throw new Error("unexpected effect"); };
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(Pool.prototype, "connect", forbidden); t.mock.method(Pool.prototype, "query", forbidden);
  for (const method of ["get", "list", "create"] as const) t.mock.method(Sandbox, method, forbidden);
  t.mock.method(caseArtifactStore, "read", forbidden); t.mock.method(caseArtifactStore, "write", forbidden);
  for (const method of ["get", "list", "resolve", "claim", "alias", "publish", "fail", "defer", "recover"] as const) t.mock.method(MemoryOperationRepository.prototype, method, forbidden);
  t.mock.method(Date, "now", forbidden);
  for (const pipeline of [3, 4, 5] as const) {
    const f = fixture(pipeline), before = structuredClone(f);
    assert.equal(historicalSourcePreflight(f.expectation, f.input, f.artifacts).sourceBatch.state, "verified-offline");
    f.input.journal = null;
    f.expectation.evidenceHash = continuationHash(f.input);
    assert.equal(historicalSourcePreflight(f.expectation, f.input, f.artifacts).sourceBatch.state, "verified-offline");
    f.input.journal = before.input.journal;
    f.expectation.evidenceHash = before.expectation.evidenceHash;
    assert.deepEqual(f, before);
    for (const mutate of [
      (f: Fixture) => { f.input.journal = null; f.input.operations.records = []; },
      (f: Fixture) => { f.input.journal!.batches.pop(); },
      (f: Fixture) => { f.input.aliases.records.push(structuredClone(f.input.aliases.records[0])); },
      (f: Fixture) => { f.artifacts.pop(); },
      (f: Fixture) => { f.artifacts[0].bytes[0] ^= 1; },
      (f: Fixture) => { f.input.operations.records[0].body.status = "running"; rehashOperations(f); },
      (f: Fixture) => { f.expectation.evidenceHash = "0".repeat(64); },
    ]) {
      const invalid = fixture(pipeline); mutate(invalid); const before = structuredClone(invalid);
      const diagnosis = historicalSourcePreflight(invalid.expectation, invalid.input, invalid.artifacts);
      assert.equal(diagnosis.state, "blocked"); assert.equal(diagnosis.sourceBatch.state, "blocked");
      assert.deepEqual(invalid, before, "blocked input also produces zero mutations/effects");
    }
  }
  assert.equal(effects, 0);
  const path = new URL("./historical-sources.ts", import.meta.url), code = readFileSync(path, "utf8");
  assert.deepEqual(inspectSource("historical-sources.ts", code).sites, [], "no classified effect calls are hidden in the pure adapter");
  assert.deepEqual([...code.matchAll(/^import (?!type).*from "([^"]+)";/gm)].map(match => match[1]), ["node:crypto", "zod", "../domain/continuation.ts", "./proposed-urls.ts"]);
  assert.deepEqual([...code.matchAll(/^import type .*from "([^"]+)";/gm)].map(match => match[1]), ["./collection.ts"]);
  assert.ok(!/\bimport\s*\(|\brequire\s*\(|\bprocess\./.test(code), "no dynamic loading or inherited environment");
});
