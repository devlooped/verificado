import { ZodError } from "zod";
import type { CourtEvent, Evidence, RecordedEvent, UnifiedSource } from "../domain/court.ts";
import { canonicalUrl, COLLECTION_BATCH, proposalsOf, type Proposal } from "./proposed-urls.ts";
import { matchQuote } from "./quote-match.ts";
import { mapLimit, type SourceService } from "./sources.ts";

export { COLLECTION_BATCH, proposalsOf, proposedUrls, type Proposal } from "./proposed-urls.ts";

// Pipeline 3: the analysts propose sources by URL and verbatim quote; the host
// fetches each URL once, files the proposals whose quote it finds as evidence,
// and groups them by canonical source, as unify_evidence did in pipeline 2.

export type FetchedUrl = { url: string; sourceId?: string; error?: string };
// finalUrl: the page the proposed URL led to, when it was read (a grounding
// redirect names no page of its own).
export type RejectedProposal = Proposal & { reason: string; finalUrl?: string };

// As for file_evidence: a passage longer than this is no longer a quote.
const MAX_EXCERPT_CHARS = 30_000;

// One bounded unit of collection. Downloads and extraction are durable,
// deduplicated source operations: a retried step reads them back. A source that
// cannot be read rejects its proposals; one still being read by another owner
// after a wait fails the step, so that the workflow retries it.
const PENDING_WAIT_MS = 60_000, PENDING_POLL_MS = 250;

export async function fetchProposedUrls(reader: SourceService, urls: readonly string[], pendingWaitMs = PENDING_WAIT_MS, progress?: (url: string, state: "started" | "ready" | "failed" | "error", durationMs: number, errorCode?: string) => void): Promise<FetchedUrl[]> {
  return mapLimit(urls, COLLECTION_BATCH, async (url) => {
    const started = Date.now();
    const report = (state: "started" | "ready" | "failed" | "error", errorCode?: string) => {
      try { progress?.(url, state, Date.now() - started, errorCode); } catch { /* telemetry is best-effort */ }
    };
    report("started");
    try {
      // Two URLs of the batch can lead to the same page (two grounding
      // redirects, or a redirect and its target): the second waits for the
      // first reading instead of failing the step.
      const deadline = Date.now() + pendingWaitMs;
      let result = await reader.read({ url, maxChars: 1 });
      while (result.status === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
        result = await reader.read({ url, maxChars: 1 });
      }
      if (result.status === "ready") { report("ready"); return { url, sourceId: result.sourceId }; }
      if (result.status === "pending") throw new Error("Source is still being read");
      const error = result.errorCode ?? `source_${result.status}`;
      report("failed", error);
      return { url, error };
    } catch (error) {
      if (error instanceof ZodError) { report("failed", "invalid_url"); return { url, error: "invalid_url" }; }
      report("error");
      throw error;
    }
  });
}

type CollectionProgress = (phase: "sources_loading" | "sources_loaded" | "matching_completed", attributes: { "sources.count": number; "proposals.count": number; "duration.ms"?: number }) => void;

export async function collectEvidence(events: readonly RecordedEvent[], fetched: readonly FetchedUrl[], reader: SourceService, progress?: CollectionProgress): Promise<{ events: CourtEvent[]; rejected: RejectedProposal[] }> {
  const byUrl = new Map(fetched.map((result) => [result.url, result]));
  const proposals = proposalsOf(events);
  const sourceIds = [...new Set(proposals.flatMap((proposal) => {
    const url = canonicalUrl(proposal.url);
    const sourceId = url ? byUrl.get(url)?.sourceId : undefined;
    return sourceId ? [sourceId] : [];
  }))];
  const attributes = { "sources.count": sourceIds.length, "proposals.count": proposals.length };
  const report = (phase: Parameters<CollectionProgress>[0], duration?: number) => {
    try { progress?.(phase, { ...attributes, ...(duration === undefined ? {} : { "duration.ms": duration }) }); } catch { /* telemetry is best-effort */ }
  };
  let started = Date.now();
  report("sources_loading");
  const sources = await reader.collectionSources(sourceIds);
  report("sources_loaded", Date.now() - started);
  started = Date.now();
  const filed: Evidence[] = [], rejected: RejectedProposal[] = [], seen = new Set<string>();
  let next = events.filter((event) => event.type === "evidence_filed").length + 1;
  for (const proposal of proposals) {
    const url = canonicalUrl(proposal.url);
    const result = url ? byUrl.get(url) : undefined;
    if (!result?.sourceId) { rejected.push({ ...proposal, reason: url ? result?.error ?? "not_fetched" : "invalid_url" }); continue; }
    const { source, blocks } = sources.get(result.sourceId)!;
    const match = matchQuote(blocks, proposal.quote);
    if (!match) { rejected.push({ ...proposal, reason: "quote_not_found", finalUrl: source.acquisition.finalUrl }); continue; }
    const excerpt = blocks.filter((block) => match.blockIds.includes(block.id)).map((block) => `[${block.id}] ${block.text}`).join("\n\n");
    if (excerpt.length > MAX_EXCERPT_CHARS) { rejected.push({ ...proposal, reason: "passage_too_long", finalUrl: source.acquisition.finalUrl }); continue; }
    // The same passage proposed twice by one analyst, with the same stance, is one contribution.
    const key = JSON.stringify([proposal.by, proposal.claimId, proposal.stance, source.sourceId, match.blockIds]);
    if (seen.has(key)) continue;
    seen.add(key);
    filed.push({ id: "P" + next++, by: proposal.by, claimId: proposal.claimId, stance: proposal.stance, title: source.document.title, url: source.acquisition.finalUrl, excerpt,
      sourceId: source.sourceId, blockIds: match.blockIds, ...(proposal.commentary ? { commentary: proposal.commentary } : {}) });
  }
  const groups = new Map<string, Evidence[]>();
  for (const evidence of filed) groups.set(evidence.sourceId!, [...groups.get(evidence.sourceId!) ?? [], evidence]);
  const unified: UnifiedSource[] = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([sourceId, contributions], index) => {
    const url = new URL(contributions[0]!.url);
    url.hash = "";
    return { id: "E" + (index + 1), title: contributions[0]!.title, url: url.href, contributions, sourceId };
  });
  report("matching_completed", Date.now() - started);
  return { events: [...filed.map((evidence): CourtEvent => ({ type: "evidence_filed", evidence })), { type: "evidence_unified", sources: unified }], rejected };
}

// The audit record of a proposal the host did not file: what was proposed, and why.
export function rejectionRecord(proposal: RejectedProposal) {
  return { schemaVersion: 2 as const, id: `proposal:${proposal.seq}`, kind: "proposal_rejected" as const, at: proposal.at, seat: proposal.by, phase: "instruction",
    data: { claimId: proposal.claimId, url: proposal.url, ...(proposal.finalUrl ? { finalUrl: proposal.finalUrl } : {}), quote: proposal.quote, stance: proposal.stance, reason: proposal.reason } };
}
