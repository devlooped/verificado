import assert from "node:assert/strict";
import test from "node:test";
import type { CourtEvent, RecordedEvent } from "../domain/court.ts";
import { collectProposedBatches } from "./proposed-urls.ts";

const proposal = (url: string, seq: number): RecordedEvent => ({ type: "evidence_proposed", by: "grok", proposal: { claimId: "A1", url, quote: "A quote", stance: "supports" }, seq, at: "2026-11-07T00:00:00.000Z" });

test("collection saves start and completed batches before fetching the next, counting unreadable URLs", async () => {
  const events = [1, 2, 3, 4, 5].map((n) => proposal(`https://example.test/${n}#fragment`, n));
  events.push(proposal("https://example.test/1", 6), proposal("https://user:password@example.test/private", 7));
  const calls: string[] = [], progress: CourtEvent[] = [];
  const fetched = await collectProposedBatches(events, async (urls, batch, batches) => {
    calls.push(`fetch:${batch}/${batches}`);
    return urls.map((url) => url.endsWith("/2") ? { url, error: "unreadable" } : { url });
  }, async (event) => { calls.push(`save:${event.type}`); progress.push(event); });
  assert.deepEqual(calls, ["save:source_collection_started", "fetch:1/2", "save:source_batch_completed", "fetch:2/2", "save:source_batch_completed"]);
  assert.equal(fetched.length, 5);
  assert.deepEqual(progress, [
    { type: "source_collection_started", total: 5, batches: 2 },
    { type: "source_batch_completed", batch: 1, batches: 2, count: 4, completed: 4, total: 5, failed: 1 },
    { type: "source_batch_completed", batch: 2, batches: 2, count: 1, completed: 5, total: 5, failed: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /https:|password|A quote/);
});

test("batch URLs are persisted before fetching and report individual outcomes", async () => {
  const events = [1, 2, 3, 4, 5].map((n) => proposal(`https://example.test/${n}#fragment`, n));
  const progress: CourtEvent[] = [];
  const fetched = await collectProposedBatches(events, async (urls, batch) => {
    const current = progress.at(-1);
    assert.deepEqual(current, { type: "source_batch_started", batch, batches: 2, urls });
    return urls.map((url) => ({ url, error: url.endsWith("/2") ? "unreadable" : undefined }));
  }, async (event) => { progress.push(event); }, true);
  assert.equal(fetched.length, 5);
  assert.deepEqual(progress.map((event) => event.type), ["source_collection_started", "source_batch_started", "source_batch_completed", "source_batch_started", "source_batch_completed"]);
  const completed = progress[2];
  assert.equal(completed.type, "source_batch_completed");
  if (completed.type !== "source_batch_completed") throw Error("unexpected event");
  assert.deepEqual(completed.sources, [1, 2, 3, 4].map((n) => ({ url: `https://example.test/${n}`, failed: n === 2 })));
});

test("a failed batch retains its started URLs and never reports completion", async () => {
  const progress: CourtEvent[] = [];
  await assert.rejects(collectProposedBatches([proposal("https://example.test/slow", 1)], async () => { throw Error("fetch failed"); }, async (event) => { progress.push(event); }, true), /fetch failed/);
  assert.deepEqual(progress.at(-1), { type: "source_batch_started", batch: 1, batches: 1, urls: ["https://example.test/slow"] });
  let fetches = 0;
  await assert.rejects(collectProposedBatches([proposal("https://example.test/slow", 1)], async () => { fetches++; return []; }, async (event) => { if (event.type === "source_batch_started") throw Error("save failed"); }, true), /save failed/);
  assert.equal(fetches, 0, "the batch is not fetched before its URL list is saved");
});

test("empty collection reports zero; a failed fetch or save stops before a false completion", async () => {
  const progress: CourtEvent[] = [];
  assert.deepEqual(await collectProposedBatches([], async () => { throw Error("unexpected fetch"); }, async (event) => { progress.push(event); }), []);
  assert.deepEqual(progress, [{ type: "source_collection_started", total: 0, batches: 0 }]);
  progress.length = 0;
  await assert.rejects(collectProposedBatches([proposal("https://example.test/1", 1)], async () => { throw Error("fetch failed"); }, async (event) => { progress.push(event); }), /fetch failed/);
  assert.deepEqual(progress, [{ type: "source_collection_started", total: 1, batches: 1 }]);
  let fetches = 0;
  await assert.rejects(collectProposedBatches([proposal("https://example.test/1", 1)], async () => { fetches++; return []; }, async () => { throw Error("save failed"); }), /save failed/);
  assert.equal(fetches, 0);
  const many = [1, 2, 3, 4, 5].map((n) => proposal(`https://example.test/${n}`, n));
  await assert.rejects(collectProposedBatches(many, async (urls) => { fetches++; return urls.map((url) => ({ url, error: undefined })); }, async (event) => { if (event.type === "source_batch_completed") throw Error("save failed"); }), /save failed/);
  assert.equal(fetches, 1, "the next batch never starts if its predecessor cannot be saved");
});
