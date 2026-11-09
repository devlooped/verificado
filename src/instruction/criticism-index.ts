import { MODEL_NAME, type SourceView } from "../domain/court.ts";
import type { SourceService } from "./sources.ts";

// What one source contributes to the index, beyond its full X post.
export const INDEX_PASSAGE_CHARS = 1_500;
// An X post is short; this only bounds a thread or a page misread as one.
const POST_CHARS = 6_000;

export function isXPost(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(hostname) && /\/status\/\d+/.test(pathname);
  } catch { return false; }
}

const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;

// Pipeline 3 criticism: one batch per analyst over every source of the shared
// file. The host builds the index from what it fetched itself: the passages
// the analysts filed and, for an X post, its whole text, which a search tool
// may not reach. Every source comes from one read of the verified artifact
// tree: a read per source downloads the whole tree each time.
export async function criticismIndex(sources: readonly SourceView[], reader: SourceService): Promise<string> {
  const loaded = await reader.collectionSources([...new Set(sources.flatMap((source) => source.sourceId ? [source.sourceId] : []))]);
  const entries: string[] = [];
  for (const source of sources) {
    const lines = [`${source.id} · "${source.title}" · ${hostOf(source.url)} · ${source.url}`];
    lines.push("  Claims: " + [...grouped(source)].map(([key, by]) => `${key} (${by.join(", ")})`).join(", "));
    const blocks = source.sourceId ? loaded.get(source.sourceId)!.blocks : [];
    if (isXPost(source.url) && blocks.length) {
      lines.push(`  Full post (fetched by the host): «${clip(blocks.map((block) => block.text).join("\n"), POST_CHARS)}»`);
    } else {
      const ids = [...new Set(source.contributions.flatMap((evidence) => evidence.blockIds ?? []))];
      const passages: string[] = [];
      let left = INDEX_PASSAGE_CHARS;
      for (const id of ids) {
        const text = blocks.find((block) => block.id === id)?.text;
        if (!text || left <= 0) continue;
        passages.push(`[${id}] «${clip(text, left)}»`);
        left -= text.length;
      }
      if (passages.length) lines.push("  Passages: " + passages.join(" "));
    }
    entries.push(lines.join("\n"));
  }
  return entries.join("\n");
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// "A1 supports" → the analysts who filed it, in filing order.
function grouped(source: SourceView): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const evidence of source.contributions) {
    const key = `${evidence.claimId} ${evidence.stance ?? "context"}`;
    const by = result.get(key) ?? [];
    if (!by.includes(MODEL_NAME[evidence.by])) by.push(MODEL_NAME[evidence.by]);
    result.set(key, by);
  }
  return result;
}
