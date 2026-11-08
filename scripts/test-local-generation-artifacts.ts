// Offline guard smoke ONLY. No PostgreSQL fixture, environment loader or DB write.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { Pool } from "pg";
import { stageGenerationArtifact, type GenerationObjectStore } from "../src/evidence/generation-artifacts.ts";
import { sha256 } from "../src/evidence/validate.ts";

let dbCalls = 0, externalCalls = 0;
mock.method(Pool.prototype, "query", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.query);
mock.method(Pool.prototype, "connect", (async () => { dbCalls++; throw new Error("DB forbidden"); }) as unknown as typeof Pool.prototype.connect);
mock.method(globalThis, "fetch", async () => { externalCalls++; throw new Error("External effects forbidden"); });
try {
  const { publishGenerationArtifactReference } = await import("../src/store.ts");
  const objects = new Map<string, Uint8Array>();
  const transport: GenerationObjectStore = {
    async createOnly(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async read(key) { return objects.get(key); },
  };
  const receipt = await stageGenerationArtifact(transport, "fixture", { generation: 1, runId: "fixture-run" }, "quick/result.json", "original", sha256("original"));
  await assert.rejects(publishGenerationArtifactReference(receipt), /generation_artifact_retention_unproved/);
  assert.equal(dbCalls, 0); assert.equal(externalCalls, 0);
  console.log("Offline generation artifact guard: genuine Map receipt blocked; DB calls 0; external calls 0.");
} finally { mock.restoreAll(); }
