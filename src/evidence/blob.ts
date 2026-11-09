import { normalizeEvidenceBytes, sha256, type EvidenceFiles } from "./validate.ts";
import { caseLog } from "../lib/case-telemetry.ts";
import { withCaseWriteLock } from "../store.ts";
import { normalizeArtifactBytes, type ArtifactStore } from "./artifacts.ts";
import { GenerationArtifactBlockedError, type StagedGenerationArtifact } from "./generation-artifacts.ts";
import type { ContinuationWriter } from "../domain/continuation.ts";
import { copyObject, deleteObjects, getObject, headObject, listAllObjects, listObjects, publicUrl, putObject, r2Config, R2Error, type R2Object } from "./r2.ts";

const ROOT = (caseId: string) => `cases/${encodeURIComponent(caseId)}/evidence/`;
const ARCHIVE = (caseId: string) => `cases/${encodeURIComponent(caseId)}/case.zip`;
const TRANSCRIPT = (caseId: string) => `cases/${encodeURIComponent(caseId)}/transcript.jsonl`;
const HASHES = ".sha256/";
// Overwritable objects are public; a CDN in front of the bucket may keep a version for a minute.
const CACHE_CONTROL = "public, max-age=60";

class EvidenceConsistencyError extends Error {}

// Server reads use the authenticated API, which is strongly consistent; the
// public bucket URL is for browsers and downloads.
async function readObject(object: { key: string; size: number }): Promise<Uint8Array> {
  const bytes = await getObject(object.key);
  if (!bytes) throw new EvidenceConsistencyError(`Evidence object disappeared while loading: ${object.key}`);
  if (bytes.byteLength !== object.size) throw new EvidenceConsistencyError(`Evidence object changed while loading: ${object.key}`);
  return bytes;
}

export function blobConfigured(): boolean {
  return Boolean(r2Config());
}

// Conditional PUT exists, but bucket retention/other writers and lifecycle rules
// are unproved. Fail before any R2/DB call; never substitute key naming for that.
export async function stageCaseGenerationArtifact(_caseId: string, _writer: ContinuationWriter, _path: string, _content: Uint8Array | string, _expectedHash: string): Promise<StagedGenerationArtifact> {
  throw new GenerationArtifactBlockedError("generation_artifact_retention_unproved");
}

// Every case run with storage configured writes under its folder, at least its base and ZIP.
export async function caseStorageExists(caseId: string): Promise<boolean> {
  return (await listObjects(`cases/${encodeURIComponent(caseId)}/`, undefined, 1)).objects.length > 0;
}

async function readEvidenceTreeOnce(caseId: string): Promise<Map<string, Uint8Array>> {
  const prefix = ROOT(caseId);
  const files = new Map<string, Uint8Array>();
  const hashes = new Map<string, { digest: string; uploadedAt: number }>();

  for (const object of await listAllObjects(prefix)) {
    const relative = object.key.slice(prefix.length);
    if (!relative) continue;
    if (relative.startsWith(HASHES)) {
      const match = /^([a-f0-9]{64})\/(.+)\.json$/.exec(relative.slice(HASHES.length));
      if (!match) continue;
      const evidencePath = `evidence/${match[2]}`;
      const uploadedAt = object.lastModified.getTime();
      const current = hashes.get(evidencePath);
      if (!current || uploadedAt >= current.uploadedAt) hashes.set(evidencePath, { digest: match[1]!, uploadedAt });
      continue;
    }
    files.set(`evidence/${relative}`, await readObject(object));
  }

  for (const path of files.keys()) {
    if (!hashes.has(path)) throw new EvidenceConsistencyError(`Evidence hash is not available yet: ${path}`);
  }
  for (const [path, hash] of hashes) {
    const value = files.get(path);
    if (!value || sha256(value) !== hash.digest) throw new EvidenceConsistencyError(`Evidence hash verification failed: ${path}`);
  }
  return files;
}

export async function readEvidenceTree(caseId: string): Promise<Map<string, Uint8Array>> {
  let consistencyError: EvidenceConsistencyError | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await readEvidenceTreeOnce(caseId);
    } catch (error) {
      if (!(error instanceof EvidenceConsistencyError)) throw error;
      consistencyError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw consistencyError ?? new Error("Could not read the evidence bundle.");
}

// Copies every object of a case to the prefix of its new id and returns the old keys,
// which the caller deletes once the database points at the new id.
export async function copyCaseBlobs(oldId: string, newId: string): Promise<string[]> {
  const from = `cases/${encodeURIComponent(oldId)}/`;
  const to = `cases/${encodeURIComponent(newId)}/`;
  const objects = await listAllObjects(from);

  // Copies get fresh upload times, so only the current hash of each file is copied;
  // otherwise a stale hash could become the newest one at the new prefix.
  const hashPrefix = from + "evidence/" + HASHES;
  const currentHash = new Map<string, R2Object>();
  for (const object of objects) {
    if (!object.key.startsWith(hashPrefix)) continue;
    const file = object.key.slice(hashPrefix.length).replace(/^[a-f0-9]{64}\//, "");
    const current = currentHash.get(file);
    if (!current || object.lastModified >= current.lastModified) currentHash.set(file, object);
  }
  const keep = new Set([...currentHash.values()].map((hash) => hash.key));

  for (const object of objects) {
    if (object.key.startsWith(hashPrefix) && !keep.has(object.key)) continue;
    await copyObject(object.key, to + object.key.slice(from.length));
  }
  return objects.map((object) => object.key);
}

export async function deleteEvidenceBlobs(keys: string[]): Promise<void> {
  if (keys.length) await deleteObjects(keys);
}

// List every page before deleting: removing a page while paging can skip objects.
// IDs include any retired aliases whose old prefixes may still have artifacts.
export async function deleteCaseBlobs(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const prefix = `cases/${encodeURIComponent(id)}/`;
    const keys = (await listAllObjects(prefix)).map((object) => object.key);
    if (keys.some((key) => !key.startsWith(prefix))) throw new Error("Blob fuera del caso solicitado.");
    await deleteEvidenceBlobs(keys);
  }
}

export type EvidenceArchive = { downloadUrl: string; etag: string };

export async function findEvidenceArchive(caseId: string): Promise<EvidenceArchive | undefined> {
  const object = await headObject(ARCHIVE(caseId));
  return object && { downloadUrl: publicUrl(object.key), etag: object.etag };
}

export async function hasEvidenceBase(caseId: string): Promise<boolean> {
  return Boolean(await headObject(`${ROOT(caseId)}base/index.md`) || await headObject(`cases/${encodeURIComponent(caseId)}/instruction/base/submission.json`) || await headObject(`cases/${encodeURIComponent(caseId)}/case.jsonl`));
}

export async function writeEvidenceArchive(caseId: string, bytes: Uint8Array): Promise<EvidenceArchive> {
  return withCaseWriteLock(caseId, async () => {
    const key = ARCHIVE(caseId);
    const { etag } = await putObject(key, bytes, {
      contentType: "application/zip",
      cacheControl: CACHE_CONTROL,
      contentDisposition: 'attachment; filename="case.zip"',
      overwrite: true,
    });
    return { downloadUrl: publicUrl(key), etag };
  });
}

export async function writeCaseTranscript(caseId: string, content: string): Promise<void> {
  await withCaseWriteLock(caseId, async () => {
    await putObject(TRANSCRIPT(caseId), content, { contentType: "application/x-ndjson; charset=utf-8", cacheControl: CACHE_CONTROL, overwrite: true });
  });
}

export async function writeEvidenceTree(caseId: string, files: EvidenceFiles): Promise<void> {
  await withCaseWriteLock(caseId, async () => {
    const prefix = ROOT(caseId);
    let totalSize = 0;
    for (const [path, content] of files) {
      if (/^evidence\/(?:E\d+\.md|manifest\.json|question\.json|index\.md)$/.test(path)) throw new Error("Settled evidence requires the immutable host artifact writer");
      const bytes = normalizeEvidenceBytes(path, content);
      totalSize += bytes.byteLength;
      if (totalSize > 25 * 1024 * 1024) throw new Error("Evidence upload exceeds 25 MiB.");
      const key = prefix + path.slice("evidence/".length);
      const digest = sha256(bytes);
      await putObject(key, bytes, {
        contentType: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream",
        cacheControl: CACHE_CONTROL,
        overwrite: true,
      });
      await putObject(`${prefix}${HASHES}${digest}/${path.slice("evidence/".length)}.json`, JSON.stringify({ path, sha256: digest }), {
        contentType: "application/json",
        cacheControl: CACHE_CONTROL,
        overwrite: true,
      });
    }
  });
}

// A retry can accept existing bytes, never overwrite a conflicting object.
async function putImmutable(key: string, bytes: Uint8Array | string, contentType: string): Promise<void> {
  try {
    await putObject(key, bytes, { contentType, overwrite: false });
  } catch (error) {
    if (!(error instanceof R2Error) || error.status !== 412) throw error;
    const existing = await getObject(key);
    if (!existing || sha256(existing) !== sha256(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)) throw error;
  }
}

// A whole-tree read downloads every artifact of the case, one object at a
// time; past this, its log is a warning (a step has 300 s in all).
const SLOW_ARTIFACT_READ_MS = 20_000;

export const caseArtifactStore: ArtifactStore = {
  read: async (caseId) => {
    const started = Date.now();
    const prefix = `cases/${encodeURIComponent(caseId)}/`;
    const files = new Map<string, Uint8Array>();
    const hashes = new Map<string, string>();
    const objects = await listAllObjects(prefix);
    const listed = Date.now() - started;
    let bytes = 0;
    for (const object of objects) {
      if (!object.key.startsWith(prefix)) throw new EvidenceConsistencyError("Artifact outside requested case");
      const path = object.key.slice(prefix.length);
      const hash = /^\.sha256\/([a-f0-9]{64})\/(.+)\.json$/.exec(path);
      if (hash) {
        if (hashes.has(hash[2]!) && hashes.get(hash[2]!) !== hash[1]) throw new EvidenceConsistencyError("Conflicting immutable artifact hashes");
        hashes.set(hash[2]!, hash[1]!);
      } else if (/^(?:instruction|evidence|discussion|quick)\//.test(path) || path === "case.jsonl" || path === "case.json") {
        const content = await readObject(object);
        bytes += content.byteLength;
        files.set(path, content);
      }
    }
    const duration = Date.now() - started;
    // Counts and durations only: which step reads the tree, how often, and at what cost.
    caseLog(caseId, duration >= SLOW_ARTIFACT_READ_MS ? "warn" : "info", "case.artifacts.read", {
      "artifacts.objects": objects.length, "artifacts.files": files.size, "artifacts.bytes": bytes, "artifacts.list_ms": listed, "duration.ms": duration,
    });
    for (const [path, bytes] of files) {
      // Bytes written before a crash are not published until their hash exists.
      if (!hashes.has(path)) { files.delete(path); continue; }
      if (sha256(bytes) !== hashes.get(path)) throw new EvidenceConsistencyError(`Artifact hash verification failed: ${path}`);
    }
    for (const path of hashes.keys()) if (!files.has(path)) throw new EvidenceConsistencyError(`Artifact is missing: ${path}`);
    return files;
  },
  write: async (caseId, files) => withCaseWriteLock(caseId, async () => {
    const prefix = `cases/${encodeURIComponent(caseId)}/`;
    let total = 0;
    for (const [path, content] of files) {
      const bytes = normalizeArtifactBytes(path, content);
      total += bytes.byteLength;
      if (total > 25 * 1024 * 1024) throw new Error("Artifact batch exceeds 25 MiB");
      const digest = sha256(bytes);
      await putImmutable(prefix + path, bytes, path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream");
      await putImmutable(`${prefix}.sha256/${digest}/${path}.json`, JSON.stringify({ path, sha256: digest }), "application/json");
    }
  }),
};
