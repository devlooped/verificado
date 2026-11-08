import { types } from "node:util";
import type { ContinuationWriter } from "../domain/continuation.ts";
import { normalizeArtifactBytes } from "./artifacts.ts";
import { sha256 } from "./validate.ts";

// Arbitrary injected dependency, NOT an attestation of provenance or bucket policy.
// Staging receipts cannot authorize publication, even after successful readback.
export interface GenerationObjectStore {
  createOnly(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | undefined>;
}

export type GenerationArtifactReference = Readonly<{
  schemaVersion: 1;
  kind: "generation_artifact_reference";
  caseId: string;
  generation: number;
  runId: string;
  path: string;
  key: string;
  sha256: string;
  byteLength: number;
}>;

declare const staged: unique symbol;
export type StagedGenerationArtifact = GenerationArtifactReference & { readonly [staged]: true };
// Only tracks local staging/cotejo. It is NOT proof of trusted remote storage,
// retention or permission to publish. Deserialization loses this local marker.
const receipts = new WeakSet<object>();

export class GenerationArtifactBlockedError extends Error {
  constructor(readonly reason: "generation_artifact_uncertain" | "generation_artifact_conflict" | "generation_artifact_retention_unproved", readonly key?: string) {
    super(`Generation artifact blocked: ${reason}`);
  }
}

function identity(value: string): void {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value || value === "." || value === ".." || /[\\/:\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid generation artifact identity");
}

export function stagedGenerationReference(receipt: StagedGenerationArtifact): GenerationArtifactReference {
  if (!receipts.has(receipt)) throw new Error("Generation artifact requires a verified staging receipt");
  return receipt;
}

// Upload alone publishes nothing. An orphan is retained, never removed here.
// This primitive is testable with explicit stores; the remote entry stays blocked.
export async function stageGenerationArtifact(store: GenerationObjectStore, caseId: string, writer: ContinuationWriter, path: string, content: Uint8Array | string, expectedHash: string): Promise<StagedGenerationArtifact> {
  identity(caseId);
  const { generation, runId } = writer;
  identity(runId);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid generation artifact generation");
  if (typeof content !== "string" && (!types.isUint8Array(content) || types.isSharedArrayBuffer(content.buffer))) throw new Error("Generation artifact requires stable bytes");
  // Snapshot before the first await; never expose this snapshot to the transport.
  const bytes = new Uint8Array(normalizeArtifactBytes(path, content));
  const digest = sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || digest !== expectedHash) throw new Error("Generation artifact bytes/hash mismatch");
  // Outside legacy cases/<id>/, hence invisible to legacy replay/copy/sweep.
  const key = `continuation-artifacts/v1/${encodeURIComponent(caseId)}/generations/${generation}/${path.split("/").map(encodeURIComponent).join("/")}/${digest}`;
  try { await store.createOnly(key, new Uint8Array(bytes)); }
  catch { /* Resolve only through exact readback, otherwise remain blocked. */ }
  let actual: Uint8Array | undefined;
  try { actual = await store.read(key); }
  catch { throw new GenerationArtifactBlockedError("generation_artifact_uncertain", key); }
  if (!actual) throw new GenerationArtifactBlockedError("generation_artifact_uncertain", key);
  // Compare exact bytes as well as hash/length; ETag is not a content digest.
  if (actual.byteLength !== bytes.byteLength || sha256(actual) !== digest || !bytes.every((byte, i) => byte === actual![i])) throw new GenerationArtifactBlockedError("generation_artifact_conflict", key);
  // An identical existing object resolves 412 and lost responses alike, ONLY
  // under the injected create-only/read contract. No implicit retries or GC.
  const receipt = Object.freeze({ schemaVersion: 1 as const, kind: "generation_artifact_reference" as const, caseId, generation, runId, path, key, sha256: digest, byteLength: bytes.byteLength }) as StagedGenerationArtifact;
  receipts.add(receipt);
  return receipt;
}

export function generationArtifactPreflight() {
  return { state: "blocked" as const, continuationEnabled: false as const, blockers: ["generation_artifact_retention_unproved", "historical_writer_inactivity_unproved", "generation_artifact_runtime_integration_unproved"] };
}
