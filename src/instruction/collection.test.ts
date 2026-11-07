import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { buildCaseLog, parseCaseLog } from "../evidence/case-log.ts";
import { collectEvidence, fetchProposedUrls, proposedUrls, rejectionRecord } from "./collection.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService } from "./sources.ts";

const pages: Record<string, string> = {
  "https://example.org/informe": "El informe oficial indica que la inflación de octubre fue del 2,7 por ciento.\n\nOtro párrafo sin relación con la afirmación.",
  "https://example.org/nota": "La nota periodística sostiene que el dato oficial fue revisado al alza.",
};
// A grounding redirect, as Gemini cites its sources.
const redirects: Record<string, string> = { "https://redirect.example/grounding/nota": "https://example.org/nota", "https://redirect.example/grounding/nota-2": "https://example.org/nota" };

function reader(extractMs = 0) {
  let downloads = 0;
  const service = new SourceService("fixture", "es", { operations: new MemoryOperationRepository(), artifacts: new MemoryArtifactStore(),
    extract: async (download, extension) => { await new Promise((resolve) => setTimeout(resolve, extractMs)); return extractSource(download, extension); },
    translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1", translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async (url) => { downloads++; const target = redirects[url] ?? url; return pages[target] ? { ok: true, finalUrl: target, redirects: target === url ? 0 : 1, contentType: "text/plain", bytes: new TextEncoder().encode(pages[target]!) } : { ok: false, error: "http_404" }; },
  });
  return { service, downloads: () => downloads };
}

let seq = 0;
const propose = (by: "grok" | "claude", claimId: string, url: string, quote: string, stance: "supports" | "opposes" | "context" = "supports"): RecordedEvent =>
  ({ type: "evidence_proposed", by, proposal: { claimId, url, quote, stance }, seq: ++seq, at: "2026-11-06T00:00:00.000Z" });

test("the host fetches each proposed URL once, files matched quotes and groups them by source", async () => {
  const events: RecordedEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: "", text: "La inflación de octubre fue del 2,7%." }], seq: ++seq, at: "2026-11-06T00:00:00.000Z" },
    propose("grok", "A1", "https://example.org/informe#tabla", "la inflacion de octubre fue del 2,7 por ciento"),
    propose("claude", "A1", "https://example.org/informe", "La inflación de octubre fue del 2,7 por ciento.", "context"),
    propose("claude", "A1", "https://example.org/informe", "La inflación de octubre fue del 2,7 por ciento.", "context"),
    propose("grok", "A1", "https://redirect.example/grounding/nota", "el dato oficial fue revisado a la baja según la nota", "opposes"),
    propose("claude", "A1", "https://example.org/caida", "Una página que ya no existe en el sitio."),
  ];
  const urls = proposedUrls(events);
  assert.deepEqual(urls, ["https://example.org/informe", "https://redirect.example/grounding/nota", "https://example.org/caida"]);
  const { service, downloads } = reader();
  const fetched = await fetchProposedUrls(service, urls);
  assert.equal(downloads(), 3);
  assert.ok(fetched[2]!.error && !fetched[2]!.sourceId, "an unreachable URL is a rejection, not a failure");
  const { events: collected, rejected } = await collectEvidence(events, fetched, service);
  const filed = collected.flatMap((event) => event.type === "evidence_filed" ? [event.evidence] : []);
  assert.deepEqual(filed.map((evidence) => [evidence.id, evidence.by, evidence.stance]), [["P1", "grok", "supports"], ["P2", "claude", "context"]], "a repeated proposal files once");
  assert.deepEqual(filed[0]!.blockIds, ["p1:b1"]);
  assert.match(filed[0]!.excerpt, /^\[p1:b1\] El informe oficial/);
  assert.equal(filed[0]!.url, "https://example.org/informe");
  const unified = collected.at(-1);
  assert.ok(unified?.type === "evidence_unified");
  assert.deepEqual(unified.sources.map((source) => [source.id, source.contributions.map((evidence) => evidence.id)]), [["E1", ["P1", "P2"]]]);
  assert.equal(unified.sources[0]!.sourceId, filed[0]!.sourceId);
  assert.deepEqual(rejected.map((proposal) => [proposal.reason, proposal.finalUrl]), [["quote_not_found", "https://example.org/nota"], ["source_failed", undefined]], "a rejection names the page a redirect led to");
  // Retried, the step reads the same operations back and files the same events.
  assert.deepEqual((await collectEvidence(events, await fetchProposedUrls(service, urls), service)).events, collected);
  assert.equal(downloads(), 3);
  const log = parseCaseLog(buildCaseLog([], rejected.map(rejectionRecord), []));
  assert.deepEqual(log.map((record) => [record.kind, record.seat, record.data.reason]), [["proposal_rejected", "grok", "quote_not_found"], ["proposal_rejected", "claude", "source_failed"]]);
  assert.equal(log[0]!.data.finalUrl, "https://example.org/nota");
});

test("two URLs that lead to the same page, read at once, wait for one reading", async () => {
  const { service, downloads } = reader(300);
  const urls = ["https://redirect.example/grounding/nota", "https://redirect.example/grounding/nota-2", "https://example.org/nota"];
  const fetched = await fetchProposedUrls(service, urls);
  assert.deepEqual(fetched.map((result) => result.error), [undefined, undefined, undefined]);
  assert.equal(new Set(fetched.map((result) => result.sourceId)).size, 1, "one source for the page");
  assert.equal(downloads(), 3);
  await assert.rejects(fetchProposedUrls(reader(300).service, urls, 0), /is still being read/, "without the wait, the step fails");
});

test("without proposals, collection files an empty source file", async () => {
  const { service } = reader();
  assert.deepEqual(await collectEvidence([], [], service), { events: [{ type: "evidence_unified", sources: [] }], rejected: [] });
});

test("source progress identifies started, completed, and failed reads without changing results", async () => {
  const { service } = reader();
  const progress: Array<[string, string, string | undefined]> = [];
  const urls = ["https://example.org/informe", "https://example.org/caida"];
  const fetched = await fetchProposedUrls(service, urls, undefined, (url, state, _duration, code) => { progress.push([url, state, code]); });
  assert.deepEqual(progress.filter((item) => item[1] === "started").map((item) => item[0]), urls);
  assert.ok(progress.some(([url, state]) => url === urls[0] && state === "ready"));
  assert.ok(progress.some(([url, state, code]) => url === urls[1] && state === "failed" && code === fetched[1]!.error));
  assert.ok(fetched[0]!.sourceId);
});
