import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { Pool } from "pg";
import { requireLocalDatabase } from "../src/lib/local-database.ts";
import { consumeSandboxBinding, createCase, deleteCase, finishCase, getCase, loadPhaseCheckpoint, openSession, recordEvents, renameCase, revokeSandboxBindings, savePhaseCheckpoint, saveSandboxBinding, sourceOperationRepository as operations } from "../src/store.ts";
import type { SandboxBinding } from "../src/instruction/authorization.ts";
import { MemoryArtifactStore } from "../src/evidence/artifacts.ts";
import { extractSource, SourceService } from "../src/instruction/sources.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const cleanup = new Pool({ connectionString: requireLocalDatabase(), connectionTimeoutMillis: 5000 });
const id = `fixture-instruction-${randomUUID()}`;
const renamed = `${id}-renamed`;
await createCase(id, { kind: "text", text: "Sanitized local-only instruction fixture." });
let current = id;
try {
  assert.equal((await getCase(id))?.pipelineVersion, 1, "unselected cases retain legacy reads");
  await assert.rejects(openSession(id, () => { throw new Error("Fixture preflight failure"); }), /Fixture preflight failure/);
  assert.equal((await getCase(id))?.status, "queued", "failed new-case preflight leaves the case unopened");
  let selections = 0;
  assert.equal((await openSession(id, () => { selections++; return 2; })).pipelineVersion, 2);
  assert.equal(selections, 1, "new cases evaluate the deployment selection");
  const noReselection = () => { throw new Error("Recorded cases must not rerun new-case preflight"); };
  assert.equal((await openSession(id, noReselection)).pipelineVersion, 2);
  assert.equal((await openSession(id, 1)).pipelineVersion, 2, "rollback cannot change an already selected shared case");
  const legacyId = `${id}-legacy`;
  await createCase(legacyId, { kind: "text", text: "Sanitized local-only legacy fixture." });
  try {
    assert.equal((await openSession(legacyId, 1)).pipelineVersion, 1);
    assert.equal((await openSession(legacyId, noReselection)).pipelineVersion, 1);
    assert.equal((await openSession(legacyId, 2)).pipelineVersion, 1, "normal deployment cannot change an already selected legacy case");
  } finally {
    await finishCase(legacyId, "failed");
    await assert.rejects(deleteCase(legacyId, async () => {}), /Sandbox cleanup blocked/);
    await cleanup.query("DELETE FROM cases WHERE id=$1", [legacyId]);
  }
  const nativeId = `${id}-native`;
  await createCase(nativeId, { kind: "text", text: "Sanitized local-only native research fixture." });
  try {
    assert.equal((await openSession(nativeId, () => 3)).pipelineVersion, 3);
    assert.equal((await openSession(nativeId, noReselection)).pipelineVersion, 3);
    assert.equal((await openSession(nativeId, 2)).pipelineVersion, 3, "rollback cannot move a pipeline 3 case back to pipeline 2");
  } finally {
    await finishCase(nativeId, "failed");
    await assert.rejects(deleteCase(nativeId, async () => {}), /Sandbox cleanup blocked/);
    await cleanup.query("DELETE FROM cases WHERE id=$1", [nativeId]);
  }
  const now = new Date().toISOString();
  await recordEvents(id, [{ type: "instruction_opened", seq: 1, at: now }]);
  const sessionKey = "instruction:grok:preparation";
  const sandboxName = `sandbox-${id}`;
  const binding: SandboxBinding = {
    phase: "instruction", seat: "grok", sessionKey, phaseSessionId: "fixture-phase", revoked: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), model: { id: "fixture/model" }, gatewayTools: [],
    activeTurn: { id: "fixture-turn", expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingRequests: 1 },
  };
  await savePhaseCheckpoint(id, sessionKey, -1, { id: binding.phaseSessionId, activeTurn: { id: binding.activeTurn!.id } });
  await saveSandboxBinding(id, sandboxName, binding);
  await assert.rejects(consumeSandboxBinding(sandboxName, `${id}-wrong-case`), /sandbox_forbidden/);
  assert.equal((await consumeSandboxBinding(sandboxName, id)).binding.activeTurn?.remainingRequests, 0);
  await assert.rejects(consumeSandboxBinding(sandboxName, id), /sandbox_forbidden/);
  await saveSandboxBinding(id, sandboxName, { ...binding, activeTurn: { ...binding.activeTurn!, remainingRequests: 2 } });
  await recordEvents(id, [{ type: "evidence_unified", sources: [], seq: 2, at: now }]);
  await assert.rejects(consumeSandboxBinding(sandboxName, id), /sandbox_forbidden/, "committed criticism blocks an old instruction binding");
  await revokeSandboxBindings(id);
  await assert.rejects(saveSandboxBinding(id, sandboxName, binding), /cannot be reassigned or unrevoked/);
  const claims = await Promise.all(Array.from({ length: 4 }, () => operations.claim(id, "fixture-acquisition", "acquisition", 30_000)));
  assert.equal(claims.filter((claim) => claim.owned).length, 1);
  const winner = claims.find((claim) => claim.owned)!;
  assert.ok(winner.owned);
  await operations.publish(id, "fixture-acquisition", winner.owner, { hash: "fixture" });
  assert.equal((await operations.claim(id, "fixture-acquisition", "acquisition", 30_000)).operation.status, "ready");
  await operations.alias(id, "https://example.test/", "src_fixture");
  const artifacts = new MemoryArtifactStore();
  let downloads = 0;
  let translations = 0;
  const services = Array.from({ length: 4 }, () => new SourceService(id, "es", {
    operations: { ...operations }, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    verifyLanguage: async () => ({ matches: true }),
    download: async (url) => { downloads++; return { ok: true, bytes: new TextEncoder().encode("Texto de prueba 42"), finalUrl: url, contentType: "text/plain", redirects: 0 }; },
    translate: async (input) => { translations++; return { ...input, changed: false }; },
  }));
  const sourceInput = { url: "https://example.test/report.txt#p1" };
  const firstReads = await Promise.all(services.map((service) => service.read(sourceInput)));
  assert.equal(firstReads.filter((read) => read.status === "ready").length, 1);
  for (const service of services) assert.equal((await service.read(sourceInput)).status, "ready");
  assert.equal(downloads, 1);
  assert.equal(translations, 0, "instruction reads are not translated");
  const sourceId = firstReads.find((read) => read.status === "ready")!.sourceId;
  for (const service of services) await service.translated(sourceId);
  assert.equal(translations, 1, "settlement translates an admitted source once");
  assert.equal(await savePhaseCheckpoint(id, "debate:grok:decision", -1, { messages: [], cursor: 0 }), 0);
  await assert.rejects(savePhaseCheckpoint(id, "debate:grok:decision", -1, {}), /Concurrent/);
  assert.equal(await savePhaseCheckpoint(id, "debate:grok:decision", 0, { messages: ["fixture"], cursor: 1 }), 1);
  await renameCase(id, renamed);
  current = renamed;
  assert.equal((await operations.get(renamed, "fixture-acquisition"))?.status, "ready");
  assert.equal(await operations.resolve(renamed, "https://example.test/"), "src_fixture");
  assert.equal((await loadPhaseCheckpoint(renamed, "debate:grok:decision"))?.revision, 1);
  assert.equal((await getCase(renamed))?.pipelineVersion, 2);
} finally {
  await finishCase(current, "failed");
  await assert.rejects(deleteCase(current, async () => {}), /Sandbox cleanup blocked/);
  // Delete only this script's synthetic fixture; no application bypass.
  await cleanup.query("DELETE FROM cases WHERE id=$1", [current]);
  await cleanup.end();
}
assert.equal(await operations.get(current, "fixture-acquisition"), undefined);
assert.equal(await operations.resolve(current, "https://example.test/"), undefined);
assert.equal(await loadPhaseCheckpoint(current, "debate:grok:decision"), undefined);
console.log("Local PostgreSQL: sandbox case/phase/budget/revocation checks, ownership, publication reuse, checkpoint CAS and case-ID regeneration; application deletion blocked, synthetic fixture cascades verified; no Blob or AI calls.");
