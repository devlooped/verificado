// Offline validation only. Never use SourceService: even its read paths can
// claim/defer operations, create aliases, download, extract or invoke models.
import { createHash } from "node:crypto";
import { z } from "zod";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { COLLECTION_BATCH, normalizeSourceUrl } from "./proposed-urls.ts";
import type { FetchedUrl } from "./collection.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
const sourceId = z.string().regex(/^src_[a-f0-9]{24}$/);
const timestamp = z.iso.datetime();
const url = z.string().refine(value => {
  try { return normalizeSourceUrl(value) === value; } catch { return false; }
});
const origin = z.object({
  caseId: id, check: z.literal("expert"), pipeline: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  runId: id, deploymentId: id, language: z.string().min(1).max(32),
  models: z.record(id, z.object({ id, effort: z.string().nullable() }).strict()),
}).strict().refine(value => ["judge", "counsel.grok", "counsel.gemini", "counsel.claude", "counsel.chatgpt"].every(role => value.models[role]));
const fetched = z.union([
  z.object({ url, sourceId }).strict(),
  z.object({ url, error: z.string().min(1).max(4096) }).strict(),
]);
const operation = z.object({
  key: id, stage: z.enum(["acquisition", "extraction", "canonical"]),
  status: z.enum(["pending", "running", "ready", "failed", "uncertain"]), at: timestamp,
  owner: id.optional(), expiresAt: timestamp.optional(),
  result: z.unknown().optional(), error: z.string().min(1).max(4096).optional(),
  recoveries: z.array(z.object({ at: timestamp, reason: id }).strict()).max(0),
}).strict(); // Generational/recovered operations require a different reviewed adapter.
const acquisition = z.object({
  sourceId, url, finalUrl: url, at: timestamp, originalPath: id, rawHash: hash,
  contentType: id, extension: id,
}).strict();
const document = z.object({
  title: z.string(), path: id, hash,
  blocks: z.array(z.object({ id: z.string().regex(/^p[1-9]\d*:b[1-9]\d*$/), page: z.number().int().positive(), offset: z.number().int().nonnegative(), length: z.number().int().positive() }).strict()).min(1),
  tool: id, confidence: z.number().min(0).max(1),
}).strict();
const reference = z.object({ path: id, hash }).strict();
const source = z.object({
  schemaVersion: z.literal(3), sourceId, acquisition,
  extraction: z.object({ version: z.literal("markdown-blocks-v1"), path: id, hash, tool: id, confidence: z.number().min(0).max(1) }).strict(),
  document,
}).strict();

// This is a new local export contract, NOT the Workflow SDK journal format.
// Origins/hashes must be supplied from independently trusted exports; internal
// consistency is not authentication of the export or proof of writer inactivity.
export const HistoricalSourceBatchSchema = z.object({
  format: z.literal("historical-source-batch/v1"), origin, caseStatus: z.literal("failed"),
  urls: z.array(url).min(1).max(1000), inputHash: hash,
  operations: z.object({ format: z.literal("source-operations/v1"), origin, records: z.array(z.object({ body: operation, hash }).strict()).max(4096) }).strict(),
  aliases: z.object({ format: z.literal("source-aliases/v1"), origin, records: z.array(z.object({ url, sourceId }).strict()).max(4096) }).strict(),
  artifacts: z.array(reference).max(4096),
  journal: z.object({
    format: z.literal("fetchProposals-results/v1"), origin,
    batches: z.array(z.object({ step: z.literal("fetchProposals"), stepId: id, ordinal: z.number().int().positive(), completedAt: timestamp, urls: z.array(url).min(1).max(COLLECTION_BATCH), inputHash: hash, result: z.array(fetched).min(1).max(COLLECTION_BATCH), resultHash: hash }).strict()).max(1000),
  }).strict().nullable(), // Explicitly unavailable permits operations-only reconstruction.
}).strict();

export type HistoricalSourceBatch = z.infer<typeof HistoricalSourceBatchSchema>;
// Pin these independently of the batch being checked. The adapter cannot
// authenticate the exporter or manufacture authoritative historical evidence.
export const HistoricalSourceExpectationSchema = z.object({ origin, inputHash: hash, evidenceHash: hash }).strict();
export type HistoricalSourceExpectation = z.infer<typeof HistoricalSourceExpectationSchema>;
export type HistoricalArtifact = { readonly path: string; readonly bytes: Uint8Array };
type Blocker = "invalid_export" | "provenance_mismatch" | "input_mismatch" | "evidence_mismatch" | "duplicate_or_collision" | "artifact_integrity" | "operation_integrity" | "operation_unresolved" | "unsupported_source" | "journal_integrity";
class Blocked extends Error { constructor(readonly code: Blocker) { super(code); } }
function requireProof(value: unknown, code: Blocker): asserts value { if (!value) throw new Blocked(code); }
function equal(left: unknown, right: unknown) { return continuationHash(left) === continuationHash(right); }
function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

export type HistoricalBatchVerification = { state: "blocked"; code: Blocker } | {
  state: "verified-offline"; continuationEnabled: false;
  origin: HistoricalSourceBatch["origin"]; inputHash: string; evidenceHash: string; resultHash: string;
  fetched: FetchedUrl[];
  failures: Array<{ url: string; error: string; operation: string; reason: string; at: string }>;
  artifacts: Array<{ path: string; hash: string }>;
  basis: "journal-and-operations" | "operations-only";
};

export function verifyHistoricalSourceBatch(expectation: unknown, input: unknown, snapshot: readonly HistoricalArtifact[]): HistoricalBatchVerification {
  try {
    continuationJson(expectation);
    const expected = HistoricalSourceExpectationSchema.parse(expectation);
    continuationJson(input); // Reject values that JSON serialization would lose.
    const batch = HistoricalSourceBatchSchema.parse(input);
    requireProof(equal(expected.origin, batch.origin) && equal(batch.origin, batch.operations.origin) && equal(batch.origin, batch.aliases.origin) && (!batch.journal || equal(batch.origin, batch.journal.origin)), "provenance_mismatch");
    requireProof(batch.inputHash === continuationHash({ origin: batch.origin, urls: batch.urls }), "input_mismatch");
    requireProof(new Set(batch.urls).size === batch.urls.length, "duplicate_or_collision");
    requireProof(batch.inputHash === expected.inputHash, "input_mismatch");

    const files = new Map<string, Uint8Array>(), manifest = new Map<string, string>();
    const usedFiles = new Set<string>(), usedOperations = new Set<string>(), sourceIds = new Set<string>();
    for (const item of batch.artifacts) {
      requireProof(!manifest.has(item.path), "duplicate_or_collision");
      requireProof(/^(instruction\/sources\/src_[a-f0-9]{24}\/(?:original\.bin|extracted\.md|source\.json)|instruction\/operations\/[a-f0-9]{64}\/extracted\.md)$/.test(item.path), "artifact_integrity");
      manifest.set(item.path, item.hash);
    }
    requireProof(snapshot.length === manifest.size, "artifact_integrity");
    for (const item of snapshot) {
      requireProof(!files.has(item.path), "duplicate_or_collision");
      requireProof(item.bytes instanceof Uint8Array && item.bytes.length <= 8 * 1024 * 1024 && manifest.get(item.path) === digest(item.bytes), "artifact_integrity");
      files.set(item.path, item.bytes);
    }
    const bytes = (path: string, expectedHash: string) => {
      requireProof(manifest.get(path) === expectedHash && files.has(path), "artifact_integrity");
      usedFiles.add(path);
      return files.get(path)!;
    };
    const text = (path: string, expectedHash: string) => new TextDecoder("utf-8", { fatal: true }).decode(bytes(path, expectedHash));
    const operations = new Map<string, z.infer<typeof operation>>();
    for (const item of batch.operations.records) {
      requireProof(!operations.has(item.body.key), "duplicate_or_collision");
      requireProof(item.hash === continuationHash(item.body), "operation_integrity");
      requireProof(["ready", "failed"].includes(item.body.status), "operation_unresolved");
      requireProof(item.body.status === "ready" ? item.body.result !== undefined && !item.body.error : !!item.body.error && item.body.result === undefined, "operation_integrity");
      operations.set(item.body.key, item.body);
    }
    const aliases = new Map<string, string>();
    for (const item of batch.aliases.records) {
      requireProof(!aliases.has(item.url), "duplicate_or_collision");
      aliases.set(item.url, item.sourceId);
    }
    requireProof(aliases.size === batch.urls.length && batch.urls.every(value => aliases.has(value)), "operation_integrity");
    const ready = (key: string, stage: string) => {
      const op = operations.get(key);
      requireProof(op?.stage === stage && op.status === "ready", "operation_integrity");
      usedOperations.add(key);
      return op.result;
    };
    const results: FetchedUrl[] = [], failures: Extract<HistoricalBatchVerification, { state: "verified-offline" }>["failures"] = [];
    for (const proposed of batch.urls) {
      // Redirect graphs and truncated-ID collisions are not reconstructed by
      // guessing. This adapter supports only direct canonical acquisitions.
      const sid = `src_${digest(new TextEncoder().encode(proposed)).slice(0, 24)}`;
      requireProof(!sourceIds.has(sid), "duplicate_or_collision"); sourceIds.add(sid);
      requireProof(aliases.get(proposed) === sid, "duplicate_or_collision");
      const root = `instruction/sources/${sid}`, key = `acquisition:${sid}`, op = operations.get(key);
      requireProof(op?.stage === "acquisition", "operation_integrity");
      usedOperations.add(key);
      if (op.status === "failed") {
        requireProof(![...files.keys()].some(path => path.startsWith(root + "/")), "operation_integrity");
        results.push({ url: proposed, error: "source_failed" });
        failures.push({ url: proposed, error: "source_failed", operation: key, reason: op.error!, at: op.at });
        continue;
      }
      const acquired = acquisition.parse(ready(key, "acquisition"));
      requireProof(acquired.sourceId === sid && acquired.url === proposed && acquired.finalUrl === proposed && acquired.originalPath === `${root}/original.bin`, "unsupported_source");
      bytes(acquired.originalPath, acquired.rawHash);
      const extractionKey = `extraction:${digest(new TextEncoder().encode(JSON.stringify([acquired.rawHash, "markdown-blocks-v1", ["html", "htm"].includes(acquired.extension) ? acquired.finalUrl : acquired.extension])))}`;
      const extracted = document.parse(ready(extractionKey, "extraction"));
      requireProof(extracted.path === `instruction/operations/${digest(new TextEncoder().encode(extractionKey))}/extracted.md`, "operation_integrity");
      const markdown = text(extracted.path, extracted.hash);
      let rendered = "", page = 0;
      const blockIds = new Set<string>();
      for (const block of extracted.blocks) {
        requireProof(!blockIds.has(block.id) && block.id.startsWith(`p${block.page}:b`), "duplicate_or_collision");
        blockIds.add(block.id);
        if (block.page !== page) { rendered += `[p.${block.page}]\n\n`; page = block.page; }
        rendered += `[${block.id}]\n\n`;
        requireProof(block.offset === rendered.length && block.offset + block.length <= markdown.length, "artifact_integrity");
        const passage = markdown.slice(block.offset, block.offset + block.length);
        requireProof(passage.trim(), "artifact_integrity");
        rendered += passage + "\n\n";
      }
      requireProof(rendered === markdown, "artifact_integrity");
      const canonicalKey = `canonical:${digest(new TextEncoder().encode(JSON.stringify([sid, extracted.hash, extracted.title, "original"])))}`;
      const canonical = reference.parse(ready(canonicalKey, "canonical"));
      requireProof(canonical.path === `${root}/source.json`, "operation_integrity");
      const json = text(canonical.path, canonical.hash), parsed: unknown = JSON.parse(json);
      // SourceService writes JSON.stringify: reject duplicate JSON keys and
      // encodings outside that concrete historical format instead of normalizing.
      requireProof(JSON.stringify(parsed) === json, "artifact_integrity");
      const stored = source.parse(parsed);
      requireProof(stored.sourceId === sid && equal(stored.acquisition, acquired) && equal(stored.extraction, { version: "markdown-blocks-v1", path: extracted.path, hash: extracted.hash, tool: extracted.tool, confidence: extracted.confidence }) && equal(stored.document, { ...extracted, title: extracted.title || acquired.finalUrl, path: `${root}/extracted.md` }), "operation_integrity");
      requireProof(text(stored.document.path, stored.document.hash) === markdown, "artifact_integrity");
      results.push({ url: proposed, sourceId: sid });
    }
    // This is a closed source-batch projection, not a complete case export.
    // Reject unrelated/contradictory references rather than ignoring them.
    requireProof(usedOperations.size === operations.size, "operation_integrity");
    requireProof(usedFiles.size === files.size, "artifact_integrity");
    if (batch.journal) {
      const count = Math.ceil(batch.urls.length / COLLECTION_BATCH), stepIds = new Set<string>();
      requireProof(batch.journal.batches.length === count, "journal_integrity");
      for (let index = 0; index < count; index++) {
        const item = batch.journal.batches[index]!, urls = batch.urls.slice(index * COLLECTION_BATCH, (index + 1) * COLLECTION_BATCH);
        requireProof(!stepIds.has(item.stepId), "duplicate_or_collision"); stepIds.add(item.stepId);
        const args = { caseId: batch.origin.caseId, language: batch.origin.language, urls, simulated: false, ...(batch.origin.pipeline === 3 ? {} : { batch: index + 1, batches: count }) };
        requireProof(item.ordinal === index + 1 && equal(item.urls, urls) && item.inputHash === continuationHash(args) && item.resultHash === continuationHash(item.result) && equal(item.result, results.slice(index * COLLECTION_BATCH, (index + 1) * COLLECTION_BATCH)), "journal_integrity");
      }
    }
    requireProof(continuationHash(batch) === expected.evidenceHash, "evidence_mismatch");
    return { state: "verified-offline", continuationEnabled: false, origin: batch.origin, inputHash: batch.inputHash, evidenceHash: continuationHash(batch), resultHash: continuationHash(results), fetched: results, failures, artifacts: batch.artifacts, basis: batch.journal ? "journal-and-operations" : "operations-only" };
  } catch (error) {
    // Public diagnostics never include URLs, source bodies, provider reasons,
    // Zod issues or private identifiers. No partial result escapes on failure.
    return { state: "blocked", code: error instanceof Blocked ? error.code : "invalid_export" };
  }
}

export function historicalSourcePreflight(expectation: unknown, input: unknown, snapshot: readonly HistoricalArtifact[]) {
  const sourceBatch = verifyHistoricalSourceBatch(expectation, input, snapshot);
  // sourceBatch is private local review data, not an admin/log response: a
  // verified projection includes URLs, identifiers and exact failure reasons.
  // No authoritative closed-world activity/control-plane verifier exists here.
  // A failed run, cancellation, expired lease, or caller's boolean cannot fill
  // that gap. Even verified source data is NOT permission to import or start.
  return { state: "blocked" as const, continuationEnabled: false as const,
    blockers: ["historical_inactivity_unproved", "continuation_disabled", ...(sourceBatch.state === "blocked" ? [sourceBatch.code] : [])], sourceBatch };
}
