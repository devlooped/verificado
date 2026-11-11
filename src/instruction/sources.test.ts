import assert from "node:assert/strict";
import { FatalError } from "workflow";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { boundBlocks, extractSource, fatalSourceFailure, markdownBlocks, normalizeOrKeep, normalizeSourceUrl, SourceService, SourceTranslationUnavailable, type SourceDependencies } from "./sources.ts";

function fixture() {
  const operations = new MemoryOperationRepository();
  const artifacts = new MemoryArtifactStore();
  const counts = { download: 0, extract: 0, translate: 0 };
  const deps: SourceDependencies = {
    operations, artifacts,
    download: async (url) => { counts.download++; return { ok: true, bytes: new TextEncoder().encode("# ForeignTitle\n\nForeignSentinel 42\n\n| ForeignColumn | Value |\n| --- | --- |\n| X | 12 |"), finalUrl: url, contentType: "text/plain", redirects: 0 }; },
    extract: async (download, extension) => { counts.extract++; return extractSource(download, extension); },
    translate: async (input) => { counts.translate++; return { ...input, title: input.title.replaceAll("ForeignTitle", "Título"), body: input.body.replaceAll("ForeignTitle", "Título").replaceAll("ForeignSentinel", "Texto canónico").replaceAll("ForeignColumn", "Columna").replaceAll("Value", "Valor"), changed: true }; },
    translatorModelId: "fixture/translator", translatorFingerprint: "fixture-translator-v1",
    verifyLanguage: async () => ({ matches: true }),
  };
  return { deps, counts, operations, service: () => new SourceService("fixture", "es", deps) };
}

test("four independent service instances share one acquisition/extraction and read the original without translating it", async () => {
  const { service, counts } = fixture();
  const services = Array.from({ length: 4 }, service);
  const inputs = { url: "https://example.test/report.txt#p3" };
  const first = await Promise.all(services.map((reader) => reader.read(inputs)));
  assert.equal(first.filter((read) => read.status === "ready").length, 1);
  assert.equal(first.filter((read) => read.status === "pending").length, 3);
  for (const reader of services) {
    const read = await reader.read(inputs);
    assert.equal(read.status, "ready");
    assert.match(JSON.stringify(read), /ForeignSentinel/);
    if (read.status === "ready") {
      assert.equal(read.reused, true);
      assert.deepEqual(read.blocks.map((block) => block.id), ["p1:b1", "p1:b2", "p1:b3"]);
    }
  }
  assert.deepEqual(counts, { download: 1, extract: 1, translate: 0 });
});

test("an admitted source is translated wholesale once, with its original block IDs, for every reader", async () => {
  const { service, counts } = fixture();
  const read = await service().read({ url: "https://example.test/report.txt" });
  assert.equal(read.status, "ready");
  const translated = [];
  for (let index = 0; index < 4; index++) translated.push(await service().translated(read.sourceId));
  assert.deepEqual(counts, { download: 1, extract: 1, translate: 3 });
  for (const result of translated) assert.deepEqual(result, translated[0]);
  assert.equal(translated[0]!.language, "es");
  assert.deepEqual(translated[0]!.translation, { version: "canonical-markdown-verified-v2", modelId: "fixture/translator", fingerprint: "fixture-translator-v1" });
  assert.deepEqual(translated[0]!.document.blocks.map((block) => block.id), ["p1:b1", "p1:b2", "p1:b3"]);
  assert.equal(translated[0]!.document.title, "https://example.test/report.txt", "an untitled source keeps its URL as title");
  assert.notEqual(translated[0]!.document.path, (await service().source(read.sourceId)).document.path, "the original stays beside its translation");
});

test("URL normalization ignores fragments but preserves query and path case; verified redirect aliases reuse acquisition", async () => {
  assert.equal(normalizeSourceUrl("HTTPS://Example.TEST:443/Report?a=1#p3"), "https://example.test/Report?a=1");
  for (const url of ["file:///tmp/a", "https://secret:password@example.test/", "ftp://example.test"]) assert.throws(() => normalizeSourceUrl(url));
  const { deps, counts, service } = fixture();
  const download = deps.download;
  deps.download = async (url) => ({ ...await download(url), finalUrl: "https://example.test/final.txt" }) as Awaited<ReturnType<typeof download>>;
  const first = await service().read({ url: "https://example.test/redirect.txt" });
  const alias = await service().read({ url: "https://example.test/final.txt#p1" });
  assert.equal(first.sourceId, alias.sourceId);
  assert.equal(counts.download, 1);
  deps.download = download;
  for (const url of ["https://example.test/Report.txt?a=1", "https://example.test/report.txt?a=1", "https://example.test/report.txt?a=2"]) assert.equal((await service().read({ url })).status, "ready");
  assert.equal(counts.download, 4);
  assert.equal(counts.extract, 1); // Identical plain-text bytes are compatible.
});

test("HTML extraction reuse includes resolved base URL and extraction version", async () => {
  const { deps, counts, service } = fixture();
  const download = deps.download;
  deps.download = async (url) => ({ ...await download(url), contentType: "text/html" }) as Awaited<ReturnType<typeof download>>;
  for (const url of ["https://example.test/a.html", "https://example.test/b.html"]) assert.equal((await service().read({ url })).status, "ready");
  assert.equal(counts.extract, 2);
  deps.extractionVersion = "fixture-extractor-v2";
  assert.equal((await service().read({ url: "https://example.test/c.html" })).status, "ready");
  assert.equal(counts.extract, 3);
});

test("same-language checks and translation model/language versions are durable keys", async () => {
  const { deps, counts, service } = fixture();
  deps.translate = async (input) => { counts.translate++; return { ...input, changed: false }; };
  await service().normalize("Título", "Texto 42");
  await service().normalize("Título", "Texto 42");
  assert.equal(counts.translate, 1);
  await new SourceService("fixture", "en", deps).normalize("Título", "Texto 42");
  assert.equal(counts.translate, 2);
  await new SourceService("fixture", "es", { ...deps, translatorFingerprint: "fixture-translator-v2" }).normalize("Título", "Texto 42");
  assert.equal(counts.translate, 3);
});

test("analyst prose keeps its own language when the translator stage is uncertain, the same on a retry", async () => {
  const { deps, counts, service } = fixture();
  // Persistent verifier rejection is no longer fatal — settlement accepts a
  // deferred translation — so normalizeOrKeep only falls back to the original
  // on genuine translator failures (uncertain external calls), not on a
  // stubborn verifier.
  deps.translate = async () => { counts.translate++; throw new Error("Gateway timeout"); };
  assert.deepEqual(await normalizeOrKeep(service(), "", "Another report"), { title: "", body: "Another report", untranslated: true });
  assert.deepEqual(await normalizeOrKeep(service(), "", "Another report"), { title: "", body: "Another report", untranslated: true });
  assert.equal(counts.translate, 1, "the failed operation is read back, not repeated");
});

test("failed translation is shared and never returns originals; explicit recovery reuses completed stages", async () => {
  const { deps, counts, operations, service } = fixture();
  const translate = deps.translate;
  deps.translate = async () => { counts.translate++; throw new Error("ForeignSentinel translator unavailable"); };
  const read = await service().read({ url: "https://example.test/a.txt" });
  const failure = async () => {
    try { await service().translated(read.sourceId); } catch (error) { if (error instanceof SourceTranslationUnavailable) return error; throw error; }
    throw new Error("Translation must fail");
  };
  const first = await failure();
  assert.equal(first.status, "uncertain");
  assert.doesNotMatch(first.message, /ForeignSentinel/);
  assert.equal((await failure()).status, "uncertain");
  assert.deepEqual(counts, { download: 1, extract: 1, translate: 3 }, "the three blocks are translated in parallel, and never again");
  const uncertain = (await operations.list("fixture")).filter((operation) => operation.status === "uncertain");
  assert.ok(uncertain.some((operation) => operation.key === first.operation));
  for (const operation of uncertain) await deps.operations.recover("fixture", operation.key, "Fixture operator authorizes retry");
  deps.translate = translate;
  const { document } = await service().translated(read.sourceId);
  assert.match(new TextDecoder().decode((await deps.artifacts.read("fixture")).get(document.path)), /Texto canónico 42/);
  assert.equal(counts.download, 1);
  assert.equal(counts.extract, 1);
});

test("failure after external work and before artifact checkpoint is uncertain, not an automatic retry", async () => {
  const { deps, counts, service } = fixture();
  deps.artifacts = { read: deps.artifacts.read.bind(deps.artifacts), write: async () => { throw new Error("storage unavailable"); } };
  const result = await service().read({ url: "https://example.test/a.txt" });
  assert.equal(result.status, "uncertain");
  await service().read({ url: "https://example.test/a.txt" });
  assert.equal(counts.download, 1);
  assert.equal(counts.extract, 0);
});

test("original and translated Markdown keep headings, tables, links, numbers, and stable block/page anchors", async () => {
  const { deps, service } = fixture();
  const read = await service().read({ url: "https://example.test/a.txt", maxChars: 10 });
  assert.equal(read.status, "ready");
  if (read.status !== "ready") return;
  assert.ok(read.truncated);
  assert.ok(read.next);
  const continuation = await service().read({ url: "https://example.test/a.txt", cursor: read.next });
  assert.equal(continuation.status, "ready");
  const source = await service().source(read.sourceId);
  const original = new TextDecoder().decode((await deps.artifacts.read("fixture")).get(source.document.path));
  assert.match(original, /\[p\.1\]\n\n\[p1:b1\]\n\n# ForeignTitle/);
  assert.match(original, /ForeignSentinel 42/);
  const translated = await service().translated(read.sourceId);
  const markdown = new TextDecoder().decode((await deps.artifacts.read("fixture")).get(translated.document.path));
  assert.match(markdown, /\[p\.1\]\n\n\[p1:b1\]/);
  assert.match(markdown, /# Título/);
  assert.match(markdown, /Texto canónico 42/);
  assert.match(markdown, /\| Columna \| Valor \|/);
  await assert.rejects(service().passages(read.sourceId, ["p9:b1"]), /Unknown/);
  const linked = await service().normalize("", "ForeignSentinel 42 [link](https://example.test/42)");
  assert.equal(linked.body, "Texto canónico 42 [link](https://example.test/42)");
});

test("translations that alter numbers or links are never published", async () => {
  const { deps, service } = fixture();
  deps.translate = async (input) => ({ ...input, body: "Changed 99 [link](https://attacker.test)", changed: true });
  await assert.rejects(service().normalize("", "ForeignSentinel 42 [link](https://example.test/42)"), /failed/);
});

for (const changed of [false, true]) test(`persistent verifier rejection marks the translation deferred rather than failing the case when changed=${changed}`, async () => {
  const { deps, counts, service } = fixture();
  let verifications = 0;
  deps.translate = async (input) => { counts.translate++; return { ...input, changed }; };
  deps.verifyLanguage = async (input, language) => {
    verifications++;
    assert.equal(language, "es");
    assert.match(input.body, /Foreign/);
    return { matches: false };
  };
  const read = await service().read({ url: "https://example.test/untranslated.txt" });
  // Protected parts (URLs, numbers, Markdown) already guard structure; a
  // verifier that keeps rejecting consistent translator output is advisory.
  const result = await service().translated(read.sourceId);
  assert.ok(result.document.blocks.length > 0);
  // The fixture source has three blocks; the verifier runs LANGUAGE_VERIFICATIONS=5 per block.
  assert.equal(verifications, 15, "the verifier runs LANGUAGE_VERIFICATIONS times per block before it is treated as advisory");
  assert.equal(counts.translate, 3);
  const files = await deps.artifacts.read("fixture");
  const translationFile = [...files].find(([path]) => path.endsWith("/translation.json"));
  assert.ok(translationFile, "a deferred translation is still checkpointed, with its verification result stored");
  const stored = JSON.parse(new TextDecoder().decode(translationFile![1])) as { verification: { matches: boolean; deferred?: true } };
  assert.deepEqual({ matches: stored.verification.matches, deferred: stored.verification.deferred }, { matches: false, deferred: true });
});

test("an uncertain translator call fails its workflow step at once, with its stored reason, and is never repeated", async () => {
  const { deps, counts, service } = fixture();
  // Persistent verifier rejection is no longer fatal: settlement accepts
  // the translator output with verification marked deferred and keeps going.
  // Uncertain translator calls (external provider errors) are the only
  // remaining fatal path for a single translation stage.
  deps.translate = async () => { counts.translate++; throw new Error("Provider connection reset"); };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(service().normalize("", "Otro texto 7"), (error) => FatalError.is(fatalSourceFailure(error)) && /is uncertain: Provider connection reset$/.test((error as Error).message));
  assert.equal(counts.translate, 1);
});

test("a service reads the artifact tree once for prose whose translations are already stored", async () => {
  const { deps, counts, service } = fixture();
  const prose = ["Primer párrafo 1.", "Segundo párrafo 2.", "Tercer párrafo 3.", "Cuarto párrafo 4."];
  let reads = 0;
  const read = deps.artifacts.read.bind(deps.artifacts);
  deps.artifacts.read = async (caseId) => { reads++; return read(caseId); };
  const writer = service();
  for (const text of prose) await writer.normalize("", text);
  assert.equal(reads, 0, "a translation this service wrote is served from memory");
  // A retried step: a new service reuses each stored translation.
  const reader = service();
  for (const text of prose) await reader.normalize("", text);
  assert.equal(counts.translate, prose.length);
  assert.equal(reads, 1, "every stored translation comes from one read of the tree");
});

test("a single false rejection of text already in the case language does not fail the operation", async () => {
  const { deps, counts, service } = fixture();
  const answers = [false, true];
  let verifications = 0;
  deps.verifyLanguage = async () => ({ matches: answers[verifications++]! });
  const task = '{"kind":"instruction","counsel":"grok"}\nEtapa de instrucción: exclusivamente aporte de pruebas. Leé las fuentes y registrá cada aporte con file_evidence.';
  assert.equal((await service().normalize("", task)).body, task);
  assert.equal((await service().normalize("", task)).body, task, "later readers reuse the confirmed checkpoint");
  assert.deepEqual({ verifications, translations: counts.translate }, { verifications: 2, translations: 1 });
  const stored = [...(await deps.artifacts.read("fixture"))].find(([path]) => path.endsWith("/translation.json"))!;
  assert.equal(JSON.parse(new TextDecoder().decode(stored[1])).rejectedVerifications, 1);
});

test("an operation another owner still runs stays retryable", async () => {
  const { deps, service } = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const translate = deps.translate;
  deps.translate = async (input, language) => { await blocked; return translate(input, language); };
  const owner = service().normalize("", "Texto 42");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = await service().normalize("", "Texto 42", 0).then(() => undefined, (error: unknown) => error);
  assert.match(String(pending), /is pending$/);
  assert.equal(fatalSourceFailure(pending), pending);
  const other = new Error("Unrelated");
  assert.equal(fatalSourceFailure(other), other);
  release();
  await owner;
});

test("successful language verification is checkpointed once for all readers", async () => {
  const { deps, service } = fixture();
  let verifications = 0;
  deps.verifyLanguage = async () => { verifications++; return { matches: true }; };
  const read = await service().read({ url: "https://example.test/verified.txt" });
  for (let index = 0; index < 4; index++) await service().translated(read.sourceId);
  assert.equal(verifications, 3);
});

test("confirmed download and unsupported-format failures are shared without retry", async () => {
  const failed = fixture();
  failed.deps.download = async () => { failed.counts.download++; return { ok: false, error: "Unavailable source" }; };
  const first = await failed.service().read({ url: "https://example.test/failure" });
  assert.equal(first.status, "failed");
  assert.deepEqual(await failed.service().read({ url: "https://example.test/failure" }), first);
  assert.equal(failed.counts.download, 1);

  const unsupported = fixture();
  unsupported.deps.download = async (url) => { unsupported.counts.download++; return { ok: true, finalUrl: url, redirects: 0, bytes: Uint8Array.of(0, 1, 2), contentType: "application/octet-stream" }; };
  const result = await unsupported.service().read({ url: "https://example.test/file.unknown" });
  assert.equal(result.status, "failed");
  assert.deepEqual(await unsupported.service().read({ url: "https://example.test/file.unknown" }), result);
  assert.equal(unsupported.counts.extract, 1);
});

test("bounded reads have explicit continuation and reject invalid ranges", () => {
  const blocks = markdownBlocks([{ page: 1, text: "# Heading\n\nA paragraph" }, { page: 2, text: "Next page" }]);
  const first = boundBlocks(blocks, 5);
  assert.equal(first.blocks[0]?.text, "# Hea");
  assert.deepEqual(first.next, { block: 0, offset: 5 });
  for (const cursor of [{ block: -1, offset: 0 }, { block: 99, offset: 0 }, { block: 0, offset: 999 }]) assert.throws(() => boundBlocks(blocks, 5, cursor));
  assert.throws(() => boundBlocks(blocks, 20_001));
});

test("sanitized AT-185-GA replay uses at most 30 acquisitions for 63 manifest-shaped requests", async () => {
  const { service, counts } = fixture();
  const data = JSON.parse(await readFile(new URL("./fixtures/at-185-ga.json", import.meta.url), "utf8"));
  let requests = 0;
  for (const group of data.groups) for (let index = 0; index < group.manifests; index++) {
    assert.equal((await service().read({ url: group.url })).status, "ready");
    requests++;
  }
  assert.equal(requests, 63);
  assert.equal(counts.download, 30);
  assert.equal(counts.extract, 1);
  assert.equal(counts.translate, 0);
});
