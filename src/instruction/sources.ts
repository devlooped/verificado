import { modelEffort, type CourtModel } from "../court/models.ts";
import { caseArtifactStore } from "../evidence/blob.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { downloadUrl, sniffExtension, type DownloadResult } from "../evidence/download.ts";
import { defaultRecognize, extractHtml, extractPdf } from "../evidence/extract.ts";
import { languageVerifierFor, translatorFor, type LanguageVerifier, type Translator } from "../evidence/translate.ts";
import { sha256 } from "../evidence/validate.ts";
import { sourceOperationRepository } from "../store.ts";
import type { OperationRepository, OperationStatus } from "./source-store.ts";
import { normalizeSourceUrl } from "./proposed-urls.ts";
import { FatalError } from "workflow";
import { z } from "zod";

export const EXTRACTION_VERSION = "markdown-blocks-v1";
export const TRANSLATION_VERSION = "canonical-markdown-verified-v2";

// The language verifier is a model, and it sometimes rejects text already in
// the case language, such as the host's own prompts. A failed operation is final,
// so a rejection is checked again this many times before it fails the case.
const LANGUAGE_VERIFICATIONS = 2;

// A completed, rejected result is different from an interrupted external call.
export class SourceProcessingFailure extends Error {}

// An admitted source could not be translated when evidence closed.
export class SourceTranslationUnavailable extends Error {
  constructor(readonly operation: string, readonly status: "pending" | "failed" | "uncertain") {
    super(`Admitted source translation ${status} (${operation}); explicit recovery required`);
  }
}

export type SourceBlock = { id: string; page: number; text: string };
export type ExtractedSource = { title: string; blocks: SourceBlock[]; tool: string; confidence: number };
type BlockLocation = { id: string; page: number; offset: number; length: number };
type StoredDocument = { title: string; path: string; hash: string; blocks: BlockLocation[]; tool: string; confidence: number };
type Acquisition = { sourceId: string; url: string; finalUrl: string; at: string; originalPath: string; rawHash: string; contentType: string; extension: string };

// Instruction and criticism read sources in their original language. Only the
// sources admitted when evidence closes are translated, wholesale, once.
export type CanonicalSource = {
  schemaVersion: 3;
  sourceId: string;
  acquisition: Acquisition;
  extraction: { version: string; path: string; hash: string; tool: string; confidence: number };
  document: StoredDocument;
};

export type TranslatedSource = Omit<CanonicalSource, "document"> & {
  language: string;
  translation: { version: string; modelId: string; fingerprint: string };
  document: StoredDocument;
};

export type SourceReadInput = { url: string; page?: number; blockIds?: string[]; maxChars?: number; cursor?: { block: number; offset: number } };
export const SourceReadSchema = z.object({
  url: z.string().url(), page: z.number().int().positive().optional(),
  blockIds: z.array(z.string().regex(/^p[1-9]\d*:b[1-9]\d*$/)).min(1).max(100).optional(),
  maxChars: z.number().int().min(1).max(20_000).optional(),
  cursor: z.object({ block: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict().optional(),
}).strict();
export type SourceReadResult = {
  sourceId: string; status: "ready"; reused: boolean; title: string;
  blocks: SourceBlock[]; truncated: boolean; next?: { block: number; offset: number };
} | { sourceId: string; status: Exclude<OperationStatus, "ready" | "running">; operation: string; errorCode?: string };

export { normalizeSourceUrl };

function sourceIdFor(url: string) { return `src_${sha256(url).slice(0, 24)}`; }
function sourceRoot(id: string) {
  if (!/^src_[a-f0-9]{24}$/.test(id)) throw new Error("Invalid source ID");
  return `instruction/sources/${id}`;
}

// Run at most `limit` calls at once, keeping the order of the results.
export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index]!, index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}

// Settlement translates blocks in parallel: a block identical to another one
// waits for its translation, for as long as its owner's lease, not two seconds.
const SETTLEMENT_TRANSLATION_WAIT_MS = 300_000;

// Chunk at Markdown block/line boundaries, never silently truncate extraction.
export function markdownBlocks(pages: Array<{ page: number; text: string }>): SourceBlock[] {
  return pages.flatMap(({ page, text }) => {
    const parts: string[] = [];
    for (const paragraph of text.trim().split(/\n\s*\n/)) {
      if (!paragraph.trim()) continue;
      if (paragraph.length <= 10_000) { parts.push(paragraph); continue; }
      let chunk = "";
      for (const line of paragraph.split("\n")) {
        if (line.length > 10_000) throw new SourceProcessingFailure("Unbounded Markdown line");
        if (chunk.length + line.length + 1 > 10_000) { parts.push(chunk); chunk = ""; }
        chunk += (chunk ? "\n" : "") + line;
      }
      if (chunk) parts.push(chunk);
    }
    return parts.map((part, index) => ({ id: `p${page}:b${index + 1}`, page, text: part }));
  });
}

export async function extractSource(download: Extract<DownloadResult, { ok: true }>, extension: string): Promise<ExtractedSource> {
  if (["html", "htm"].includes(extension)) {
    const result = await extractHtml(new TextDecoder().decode(download.bytes), download.finalUrl);
    return { title: result.title ?? download.finalUrl, blocks: markdownBlocks([{ page: 1, text: result.markdown }]), tool: result.tool, confidence: result.confidence };
  }
  if (extension === "pdf") {
    const result = await extractPdf(download.bytes);
    if (!result.ok) throw new SourceProcessingFailure("Source extraction failed");
    return { title: "", blocks: markdownBlocks(result.pages), tool: result.tool, confidence: result.confidence };
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    const result = await defaultRecognize(download.bytes, mime);
    return { title: "", blocks: markdownBlocks([{ page: 1, text: result.text }]), tool: result.tool, confidence: result.confidence };
  }
  if (["txt", "md", "csv"].includes(extension)) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(download.bytes); }
    catch { throw new SourceProcessingFailure("Invalid source text encoding"); }
    return { title: "", blocks: markdownBlocks([{ page: 1, text }]), tool: "text-markdown", confidence: 1 };
  }
  throw new SourceProcessingFailure("Unsupported source format");
}

function renderDocument(source: ExtractedSource, path: string): { markdown: string; document: StoredDocument } {
  let markdown = "";
  let page = 0;
  const blocks: BlockLocation[] = [];
  for (const block of source.blocks) {
    if (block.page !== page) { markdown += `[p.${block.page}]\n\n`; page = block.page; }
    markdown += `[${block.id}]\n\n`;
    blocks.push({ id: block.id, page: block.page, offset: markdown.length, length: block.text.length });
    markdown += block.text + "\n\n";
  }
  return { markdown, document: { title: source.title, path, hash: sha256(markdown), blocks, tool: source.tool, confidence: source.confidence } };
}

const protectedParts = (text: string) => [...text.matchAll(/https?:\/\/[^\s)<>]+|\]\([^)]*\)|\d+(?:[.,]\d+)*|^\s*#{1,6}\s|\|/gm)].map((match) => match[0]);

class StageUnavailable extends Error {
  constructor(readonly operation: string, readonly status: "pending" | "failed" | "uncertain", stage: string, reason?: string) {
    super(`Source ${stage} operation ${operation} is ${status}${reason ? `: ${reason.slice(0, 200)}` : ""}`);
  }
}

// Prose an analyst writes during instruction or criticism: a translation that
// failed, or whose outcome is uncertain, keeps the text in its own language
// instead of failing the case. The operation stays failed in the case log, and
// a retried step reads the same status, so it keeps the same text. A
// translation another owner still runs is still worth a retry.
export async function normalizeOrKeep(reader: Pick<SourceService, "normalize">, title: string, body: string): Promise<{ title: string; body: string; untranslated?: true }> {
  try { return await reader.normalize(title, body); }
  catch (error) {
    if (error instanceof StageUnavailable && error.status !== "pending") return { title, body, untranslated: true };
    throw error;
  }
}

// A failed or uncertain operation stays so until an explicit, reviewed recovery:
// a retried workflow step would only read the same stored status again. Only an
// operation another owner still runs is worth a retry.
export function fatalSourceFailure(error: unknown): unknown {
  if ((error instanceof StageUnavailable || error instanceof SourceTranslationUnavailable) && error.status !== "pending") return new FatalError(error.message);
  return error;
}

export type SourceDependencies = {
  operations: OperationRepository;
  artifacts: ArtifactStore;
  download: typeof downloadUrl;
  extract: typeof extractSource;
  translate: Translator;
  verifyLanguage: LanguageVerifier;
  translatorModelId: string;
  translatorEffort?: string | null;
  translatorFingerprint: string;
  extractionVersion?: string;
};

export function liveSourceDependencies(translator: CourtModel, caseId?: string): SourceDependencies {
  return { operations: sourceOperationRepository, artifacts: caseArtifactStore, download: downloadUrl, extract: extractSource, translate: translatorFor(translator, caseId), verifyLanguage: languageVerifierFor(translator, caseId), translatorModelId: translator.id, translatorEffort: modelEffort(translator), translatorFingerprint: sha256(JSON.stringify([translator.id, translator.providerOptions, TRANSLATION_VERSION])) };
}

export class SourceService {
  constructor(readonly caseId: string, readonly language: string, private readonly deps: SourceDependencies) {
    // The legacy stage callbacks/paths are not a generational effects protocol.
    // Reject explicit new scope before even reading or writing artifact storage.
    if (deps.operations.writer) throw new Error("Generational source execution blocked: effect dispatch and artifact retention are not verified");
  }

  async hostStage<T>(key: string, stage: string, run: () => Promise<T>): Promise<T> {
    return (await this.stage(key, stage, run)).value;
  }

  private async translationStage<T>(key: string, run: () => Promise<T>, wait = 2000): Promise<{ value: T; reused: boolean }> {
    const deadline = Date.now() + wait;
    for (;;) {
      try { return await this.stage(key, "translation", run); }
      catch (error) {
        if (!(error instanceof StageUnavailable) || error.status !== "pending" || Date.now() >= deadline) throw error;
        // Briefly await another owner's publication, never take over its job.
        await new Promise((resolve) => setTimeout(resolve, wait > 2000 ? 500 : 40));
      }
    }
  }

  private async stage<T>(key: string, stage: string, run: () => Promise<T>): Promise<{ value: T; reused: boolean }> {
    const claim = await this.deps.operations.claim(this.caseId, key, stage, 300_000);
    if (!claim.owned) {
      if (claim.operation.status === "ready") return { value: claim.operation.result as T, reused: true };
      const status = claim.operation.status === "running" ? "pending" : claim.operation.status;
      throw new StageUnavailable(key, status, claim.operation.stage, status === "pending" ? undefined : claim.operation.error);
    }
    try {
      const value = await run();
      await this.deps.operations.publish(this.caseId, key, claim.owner, value);
      return { value, reused: false };
    } catch (error) {
      if (error instanceof StageUnavailable && stage === "canonical") {
        // Assembly has no uncheckpointed external work of its own. Its child
        // operations retain ownership/failure; another reader may finish assembly.
        await this.deps.operations.defer(this.caseId, key, claim.owner);
        throw error;
      }
      // An interrupted external operation must never be silently repeated.
      const uncertain = !(error instanceof SourceProcessingFailure);
      const reason = error instanceof Error ? error.message : "Source processing failed";
      await this.deps.operations.fail(this.caseId, key, claim.owner, reason, uncertain).catch(() => {});
      throw new StageUnavailable(key, uncertain ? "uncertain" : "failed", stage, reason);
    }
  }

  private fileFrom(files: ReadonlyMap<string, Uint8Array>, path: string, expectedHash: string): string {
    const bytes = files.get(path);
    if (!bytes || sha256(bytes) !== expectedHash) throw new Error("Required source artifact missing or changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private async file(path: string, expectedHash: string): Promise<string> {
    return this.fileFrom(await this.deps.artifacts.read(this.caseId), path, expectedHash);
  }

  private async writeDocument(source: ExtractedSource, path: string): Promise<StoredDocument> {
    const rendered = renderDocument(source, path);
    await this.deps.artifacts.write(this.caseId, new Map([[path, rendered.markdown]]));
    return rendered.document;
  }

  private blocksFrom(files: ReadonlyMap<string, Uint8Array>, document: StoredDocument): SourceBlock[] {
    const markdown = this.fileFrom(files, document.path, document.hash);
    return document.blocks.map(({ id, page, offset, length }) => ({ id, page, text: markdown.slice(offset, offset + length) }));
  }

  async blocks(document: StoredDocument): Promise<SourceBlock[]> {
    return this.blocksFrom(await this.deps.artifacts.read(this.caseId), document);
  }

  // Used for snippets, submission descriptions, court prose, and source titles.
  // Each chunk's language decision is checkpointed along with its translation.
  async normalize(title: string, body: string, wait?: number): Promise<{ title: string; body: string }> {
    const chunks = markdownBlocks([{ page: 1, text: body }]);
    if (!chunks.length) chunks.push({ id: "p1:b1", page: 1, text: "" });
    const output: string[] = [];
    let translatedTitle = title;
    for (const [index, chunk] of chunks.entries()) {
      const input = { title: index === 0 ? title : "", description: "", body: chunk.text };
      const key = `translation:${sha256(JSON.stringify([input, this.language, this.deps.translatorFingerprint, TRANSLATION_VERSION]))}`;
      const result = await this.translationStage<{ path: string; hash: string; modelId: string; effort: string | null; usage: unknown }>(key, async () => {
        const translated = await this.deps.translate(input, this.language);
        if ((input.title && !translated.title.trim()) || (input.body && !translated.body.trim()) ||
            JSON.stringify(protectedParts(input.title)) !== JSON.stringify(protectedParts(translated.title)) ||
            JSON.stringify(protectedParts(input.body)) !== JSON.stringify(protectedParts(translated.body))) throw new SourceProcessingFailure("Translation changed protected Markdown, links, or numbers");
        let verification = await this.deps.verifyLanguage({ title: translated.title, body: translated.body }, this.language);
        let rejectedVerifications = 0;
        while (!verification.matches && ++rejectedVerifications < LANGUAGE_VERIFICATIONS) {
          verification = await this.deps.verifyLanguage({ title: translated.title, body: translated.body }, this.language);
        }
        if (!verification.matches) throw new SourceProcessingFailure("Translation language could not be confirmed");
        const content = JSON.stringify({ title: translated.title, body: translated.body, changed: translated.changed, language: this.language, verification, ...(rejectedVerifications ? { rejectedVerifications } : {}), usage: translated.usage ?? null });
        const path = `instruction/operations/${sha256(key)}/translation.json`;
        await this.deps.artifacts.write(this.caseId, new Map([[path, content]]));
        return { path, hash: sha256(content), modelId: this.deps.translatorModelId, effort: this.deps.translatorEffort ?? null, usage: translated.usage ?? null, verificationUsage: verification.usage ?? null };
      }, wait);
      const translated = JSON.parse(await this.file(result.value.path, result.value.hash)) as { title: string; body: string };
      if (index === 0) translatedTitle = translated.title;
      output.push(translated.body);
    }
    return { title: translatedTitle, body: output.join("\n\n") };
  }

  private sourceFrom(files: ReadonlyMap<string, Uint8Array>, sourceId: string): CanonicalSource {
    const file = files.get(`${sourceRoot(sourceId)}/source.json`);
    if (!file) throw new Error("Canonical source unavailable");
    const source = JSON.parse(new TextDecoder().decode(file)) as CanonicalSource;
    if (source.sourceId !== sourceId || source.schemaVersion !== 3) throw new Error("Canonical source mismatch");
    this.fileFrom(files, source.document.path, source.document.hash);
    return source;
  }

  async source(sourceId: string): Promise<CanonicalSource> {
    return this.sourceFrom(await this.deps.artifacts.read(this.caseId), sourceId);
  }

  // Collection and the criticism index are read-only: load the verified
  // artifact tree once for all their sources, rather than downloading the
  // whole tree per source/block.
  async collectionSources(sourceIds: readonly string[]): Promise<Map<string, { source: CanonicalSource; blocks: SourceBlock[] }>> {
    if (!sourceIds.length) return new Map();
    const files = await this.deps.artifacts.read(this.caseId);
    return new Map(sourceIds.map((sourceId) => {
      const source = this.sourceFrom(files, sourceId);
      return [sourceId, { source, blocks: this.blocksFrom(files, source.document) }];
    }));
  }

  // Host-only, once evidence closes: translate a whole admitted source into the
  // case language. Blocks keep their original IDs, so citations carry over.
  async translated(sourceId: string): Promise<TranslatedSource> {
    const source = await this.source(sourceId);
    const root = sourceRoot(sourceId);
    const key = `translated:${sha256(JSON.stringify([sourceId, source.document.hash, source.document.title, this.language, this.deps.translatorFingerprint, TRANSLATION_VERSION]))}`;
    try {
      const stored = await this.stage<{ path: string; hash: string }>(key, "canonical", async () => {
        const blocks = await this.blocks(source.document);
        const title = source.document.title === source.acquisition.finalUrl ? "" : source.document.title;
        const translated = await mapLimit(blocks, 4, (block, index) => this.normalize(index === 0 ? title : "", block.text, SETTLEMENT_TRANSLATION_WAIT_MS));
        const path = `${root}/translations/${this.language}/${this.deps.translatorFingerprint}`;
        const document = await this.writeDocument({ title: translated[0]?.title || source.acquisition.finalUrl, tool: source.document.tool, confidence: source.document.confidence,
          blocks: blocks.map((block, index) => ({ ...block, text: translated[index]!.body })) }, `${path}.md`);
        const result: TranslatedSource = { ...source, language: this.language, translation: { version: TRANSLATION_VERSION, modelId: this.deps.translatorModelId, fingerprint: this.deps.translatorFingerprint }, document };
        const content = JSON.stringify(result);
        await this.deps.artifacts.write(this.caseId, new Map([[`${path}.json`, content]]));
        return { path: `${path}.json`, hash: sha256(content) };
      });
      const result = JSON.parse(await this.file(stored.value.path, stored.value.hash)) as TranslatedSource;
      await this.file(result.document.path, result.document.hash);
      return result;
    } catch (error) {
      if (error instanceof StageUnavailable) throw new SourceTranslationUnavailable(error.operation, error.status);
      throw error;
    }
  }

  async passages(sourceId: string, ids: readonly string[]): Promise<{ source: CanonicalSource; blocks: SourceBlock[] }> {
    const source = await this.source(sourceId);
    const blocks = await this.blocks(source.document);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !blocks.some((block) => block.id === id))) throw new Error("Unknown source blocks");
    return { source, blocks: blocks.filter((block) => ids.includes(block.id)) };
  }

  // Host-only intake: detect the case language from extraction, without exposing
  // the source language to a participating seat or translating prematurely.
  async inspect(rawUrl: string): Promise<{ sourceId: string; acquisition: Acquisition; document: StoredDocument; blocks: SourceBlock[] }> {
    const url = normalizeSourceUrl(rawUrl);
    const sourceId = await this.deps.operations.alias(this.caseId, url, sourceIdFor(url));
      const acquired = await this.stage<Acquisition>(`acquisition:${sourceId}`, "acquisition", async () => {
        const downloaded = await this.deps.download(url);
        if (!downloaded.ok) throw new SourceProcessingFailure(downloaded.error);
        const finalUrl = normalizeSourceUrl(downloaded.finalUrl);
        const originalPath = `${sourceRoot(sourceId)}/original.bin`;
        await this.deps.artifacts.write(this.caseId, new Map([[originalPath, downloaded.bytes]]));
        return { sourceId, url, finalUrl, at: new Date().toISOString(), originalPath, rawHash: sha256(downloaded.bytes), contentType: downloaded.contentType, extension: sniffExtension(downloaded.bytes, downloaded.contentType, new URL(finalUrl).pathname) };
      });
      const acquisition = acquired.value;
      const canonicalId = await this.deps.operations.alias(this.caseId, acquisition.finalUrl, sourceId);
      if (canonicalId !== sourceId) return this.inspect(acquisition.finalUrl);
      const extractionKey = `extraction:${sha256(JSON.stringify([acquisition.rawHash, this.deps.extractionVersion ?? EXTRACTION_VERSION, ["html", "htm"].includes(acquisition.extension) ? acquisition.finalUrl : acquisition.extension]))}`;
      const extracted = await this.stage<StoredDocument>(extractionKey, "extraction", async () => {
        const bytes = (await this.deps.artifacts.read(this.caseId)).get(acquisition.originalPath);
        if (!bytes || sha256(bytes) !== acquisition.rawHash) throw new SourceProcessingFailure("Original source missing or changed");
        const result = await this.deps.extract({ ok: true, bytes, contentType: acquisition.contentType, finalUrl: acquisition.finalUrl, redirects: 0 }, acquisition.extension);
        if (!result.blocks.length || !result.blocks.some((block) => block.text.trim())) throw new SourceProcessingFailure("Source extraction empty");
        return this.writeDocument(result, `instruction/operations/${sha256(extractionKey)}/extracted.md`);
      });
      return { sourceId, acquisition, document: extracted.value, blocks: await this.blocks(extracted.value) };
  }

  async read(input: SourceReadInput): Promise<SourceReadResult> {
    input = SourceReadSchema.parse(input);
    const fallbackId = await this.deps.operations.resolve(this.caseId, normalizeSourceUrl(input.url)) ?? sourceIdFor(normalizeSourceUrl(input.url));
    const previous = (await this.deps.artifacts.read(this.caseId)).get(`${sourceRoot(fallbackId)}/source.json`);
    if (previous) {
      const source = JSON.parse(new TextDecoder().decode(previous)) as CanonicalSource;
      if (source.schemaVersion !== 3 || source.extraction.version !== (this.deps.extractionVersion ?? EXTRACTION_VERSION)) throw new Error("Source processing snapshot changed; a reviewed revision is required");
    }
    try {
      const { sourceId, acquisition, document: extracted } = await this.inspect(input.url);
      // Not translated: that would spend the turn's time on sources that may never be admitted.
      const sourceKey = `canonical:${sha256(JSON.stringify([sourceId, extracted.hash, extracted.title, "original"]))}`;
      const canonical = await this.stage<{ path: string; hash: string }>(sourceKey, "canonical", async () => {
        const markdown = await this.file(extracted.path, extracted.hash);
        const documentPath = `${sourceRoot(sourceId)}/extracted.md`;
        await this.deps.artifacts.write(this.caseId, new Map([[documentPath, markdown]]));
        const source: CanonicalSource = { schemaVersion: 3, sourceId, acquisition,
          extraction: { version: this.deps.extractionVersion ?? EXTRACTION_VERSION, path: extracted.path, hash: extracted.hash, tool: extracted.tool, confidence: extracted.confidence },
          document: { ...extracted, title: extracted.title || acquisition.finalUrl, path: documentPath } };
        const content = JSON.stringify(source);
        const path = `${sourceRoot(sourceId)}/source.json`;
        await this.deps.artifacts.write(this.caseId, new Map([[path, content]]));
        return { path, hash: sha256(content) };
      });
      const source = JSON.parse(await this.file(canonical.value.path, canonical.value.hash)) as CanonicalSource;
      let blocks = await this.blocks(source.document);
      if (input.page !== undefined) {
        if (!blocks.some((block) => block.page === input.page)) throw new Error("Unknown source page");
        blocks = blocks.filter((block) => block.page === input.page);
      }
      if (input.blockIds) {
        if (input.blockIds.some((id) => !blocks.some((block) => block.id === id))) throw new Error("Unknown source blocks");
        blocks = blocks.filter((block) => input.blockIds!.includes(block.id));
      }
      const result = boundBlocks(blocks, input.maxChars, input.cursor);
      return { sourceId, status: "ready", reused: canonical.reused, title: source.document.title, ...result };
    } catch (error) {
      if (error instanceof StageUnavailable) return { sourceId: fallbackId, status: error.status, operation: error.operation, errorCode: `source_${error.status}` };
      throw error;
    }
  }
}

export function boundBlocks(blocks: SourceBlock[], maxChars = 6000, cursor = { block: 0, offset: 0 }): { blocks: SourceBlock[]; truncated: boolean; next?: { block: number; offset: number } } {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000 || !Number.isInteger(cursor.block) || cursor.block < 0 || cursor.block > blocks.length || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > (blocks[cursor.block]?.text.length ?? 0)) throw new Error("Invalid bounded read range");
  const output: SourceBlock[] = [];
  let remaining = maxChars;
  for (let index = cursor.block; index < blocks.length; index++) {
    const block = blocks[index]!;
    const offset = index === cursor.block ? cursor.offset : 0;
    const text = block.text.slice(offset, offset + remaining);
    if (text) output.push({ ...block, text });
    remaining -= text.length;
    if (offset + text.length < block.text.length) return { blocks: output, truncated: true, next: { block: index, offset: offset + text.length } };
    if (!remaining && index + 1 < blocks.length) return { blocks: output, truncated: true, next: { block: index + 1, offset: 0 } };
  }
  return { blocks: output, truncated: false };
}
