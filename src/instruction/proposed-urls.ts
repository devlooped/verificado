import type { CourtEvent, Evidence, EvidenceProposal, RecordedEvent } from "../domain/court.ts";

// The part of native collection that the court-session workflow runs
// itself, outside its steps: it imports no Node.js modules, so that it can go
// in the workflow bundle. Downloads and filing stay in collection.ts.

export type Proposal = EvidenceProposal & { by: Evidence["by"]; seq: number; at: string };

// The URLs fetched by one workflow step, so that no step waits on more than a
// few downloads.
export const COLLECTION_BATCH = 4;

export function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid source URL");
  url.hash = "";
  return url.href;
}

export function proposalsOf(events: readonly RecordedEvent[]): Proposal[] {
  return events.flatMap((event) => event.type === "evidence_proposed" ? [{ ...event.proposal, by: event.by, seq: event.seq, at: event.at }] : []);
}

export function canonicalUrl(url: string): string | undefined {
  try { return normalizeSourceUrl(url); } catch { return undefined; }
}

// Every proposed URL once, in the order first proposed.
export function proposedUrls(events: readonly RecordedEvent[]): string[] {
  return [...new Set(proposalsOf(events).flatMap((proposal) => canonicalUrl(proposal.url) ?? []))];
}

type CollectionProgress = Extract<CourtEvent, { type: "source_collection_started" | "source_batch_started" | "source_batch_completed" }>;

// Workflow-side orchestration: persist each completed batch before starting the next.
export async function collectProposedBatches<T extends { url: string; error?: string }>(events: readonly RecordedEvent[], fetch: (urls: string[], batch: number, batches: number) => Promise<T[]>, report: (event: CollectionProgress) => Promise<void>, showUrls = false): Promise<T[]> {
  const urls = proposedUrls(events), batches = Math.ceil(urls.length / COLLECTION_BATCH), fetched: T[] = [];
  await report({ type: "source_collection_started", total: urls.length, batches });
  for (let start = 0; start < urls.length; start += COLLECTION_BATCH) {
    const batch = start / COLLECTION_BATCH + 1;
    const batchUrls = urls.slice(start, start + COLLECTION_BATCH);
    if (showUrls) await report({ type: "source_batch_started", batch, batches, urls: batchUrls });
    const results = await fetch(batchUrls, batch, batches);
    fetched.push(...results);
    await report({ type: "source_batch_completed", batch, batches, count: results.length, completed: fetched.length, total: urls.length, failed: results.filter((result) => result.error).length, ...(showUrls ? { sources: results.map(({ url, error }) => ({ url, failed: Boolean(error) })) } : {}) });
  }
  return fetched;
}
