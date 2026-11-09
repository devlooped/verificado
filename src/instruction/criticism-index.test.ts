import assert from "node:assert/strict";
import test from "node:test";
import type { Evidence, SourceView } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { criticismIndex, INDEX_PASSAGE_CHARS, isXPost } from "./criticism-index.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService } from "./sources.ts";

const post = "https://x.com/organismo/status/1234567890";
const report = "https://www.example.org/informe";
const pages: Record<string, string> = {
  [post]: "Comunicado oficial: el organismo confirma la cifra de octubre.\n\nSegunda parte del hilo, con la fuente del dato y el enlace al informe completo.",
  [report]: ["Primer párrafo del informe, con la cifra de octubre.", "Segundo párrafo, " + "con mucho detalle metodológico ".repeat(80), "Tercer párrafo, que nadie citó."].join("\n\n"),
};

test("the criticism index lists every E source, its passages within a cap, and the whole text of an X post", async () => {
  const artifacts = new MemoryArtifactStore();
  const reader = new SourceService("fixture", "es", { operations: new MemoryOperationRepository(), artifacts, extract: extractSource,
    translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1", translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async (url) => ({ ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode(pages[url]!) }),
  });
  const ids = { post: (await reader.read({ url: post })).sourceId, report: (await reader.read({ url: report })).sourceId };
  const evidence = (id: string, by: Evidence["by"], claimId: string, stance: Evidence["stance"], url: string, sourceId: string, blockIds: string[]): Evidence =>
    ({ id, by, claimId, stance, title: "Título", url, excerpt: "", sourceId, blockIds });
  const sources: SourceView[] = [
    { id: "E1", title: "Comunicado", url: post, sourceId: ids.post, votes: {}, contributions: [evidence("P1", "grok", "A1", "supports", post, ids.post, ["p1:b1"]), evidence("P2", "grok", "A2", "context", post, ids.post, ["p1:b1"])] },
    { id: "E2", title: "Informe anual", url: report, sourceId: ids.report, votes: {}, contributions: [evidence("P3", "claude", "A1", "opposes", report, ids.report, ["p1:b1", "p1:b2"]), evidence("P4", "gemini", "A1", "opposes", report, ids.report, ["p1:b2"])] },
  ];
  let reads = 0;
  const read = artifacts.read.bind(artifacts);
  artifacts.read = async (caseId) => { reads++; return read(caseId); };
  const index = await criticismIndex(sources, reader);
  assert.equal(reads, 1, "every source comes from one read of the artifact tree");
  for (const source of sources) assert.match(index, new RegExp(`^${source.id} · "${source.title}" · `, "m"));
  assert.match(index, /Claims: A1 supports \(Grok\), A2 context \(Grok\)/);
  assert.match(index, /Claims: A1 opposes \(Claude, Gemini\)/);
  assert.match(index, /Full post \(fetched by the host\): «Comunicado oficial[^»]*Segunda parte del hilo[^»]*»/);
  assert.match(index, /example\.org · https:\/\/www\.example\.org\/informe/);
  const passages = index.split("\n").find((line) => line.includes("[p1:b1] «Primer párrafo"))!;
  assert.ok(passages.includes("[p1:b2]"));
  assert.ok(!index.includes("Tercer párrafo"), "only the filed passages");
  assert.ok(passages.length < INDEX_PASSAGE_CHARS + 100, "the passages of one source stay within the cap");
  assert.ok(isXPost("https://twitter.com/a/status/1") && !isXPost("https://x.com/organismo") && !isXPost(report));
});
