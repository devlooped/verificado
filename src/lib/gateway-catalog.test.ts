import assert from "node:assert/strict";
import test from "node:test";
import { cachedCatalog, fetchModelsDev, parseCatalog, parseModelsDev } from "./gateway-catalog.ts";

test("parseCatalog keeps id, name, type, tags and effort values, sorted by id", () => {
  const models = parseCatalog({ data: [
    { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language", tags: ["tool-use", 1], reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] },
    { id: "google/gemini-3.5-flash-lite", type: "language" },
    { name: "no id" },
  ] });
  assert.deepEqual(models, [
    { id: "google/gemini-3.5-flash-lite", name: "google/gemini-3.5-flash-lite", type: "language", tags: [], efforts: [] },
    { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language", tags: ["tool-use"], efforts: ["low", "high"] },
  ]);
  assert.throws(() => parseCatalog({ models: [] }), /formato/);
});

test("models.dev is authoritative; Gateway only enriches exact IDs", () => {
  const body = { vercel: { models: {
    "deepseek/deepseek-v4-flash": { name: "Flash", modalities: { output: ["text"] } },
    "google/imagen-4": { modalities: { output: ["image"] } },
    "bad id": { modalities: { output: ["text"] } },
    "provider/audio-1": { modalities: { output: ["audio"] } },
  } } };
  const gateway = parseCatalog({ data: [{ id: "deepseek/deepseek-v4-flash", type: "language", tags: ["vision"], reasoning_options: [{ type: "effort", values: ["high"] }] }, { id: "provider/not-in-models-dev", type: "language" }] });
  const models = parseModelsDev(body, gateway);
  assert.deepEqual(models.map((m) => m.id), ["deepseek/deepseek-v4-flash", "google/imagen-4"]);
  assert.deepEqual(models[0]?.efforts, ["high"]);
  assert.equal(models[1]?.type, "image");
  assert.throws(() => parseModelsDev({}), /formato/);
});

test("fetchModelsDev tolerates unavailable Gateway metadata but not an unavailable models.dev catalog", async () => {
  const urls: string[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.equal(init?.headers, undefined);
    if (String(url).includes("models.dev")) return Response.json({ vercel: { models: { "test/model-1": { modalities: { output: ["text"] } } } } });
    throw new Error("Gateway unavailable");
  }) as typeof fetch;
  assert.deepEqual((await fetchModelsDev(request)).map((m) => m.id), ["test/model-1"]);
  assert.deepEqual(urls.sort(), ["https://ai-gateway.vercel.sh/v1/models", "https://models.dev/api.json"]);
  await assert.rejects(fetchModelsDev((async () => { throw new Error("offline"); }) as typeof fetch), /offline/);
});

test("catalog cache coalesces reads, refreshes after TTL and retries failures", async () => {
  let time = 0, calls = 0, fail = false;
  const value = [{ id: "a/b-1", name: "b", type: "language", tags: [], efforts: [] }];
  const read = cachedCatalog(async () => { calls++; if (fail) throw new Error("offline"); return value; }, 100, () => time);
  await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  time = 99; await read(); assert.equal(calls, 1);
  time = 100; await read(); assert.equal(calls, 2);
  fail = true; time = 200;
  assert.deepEqual(await read(), value);
  assert.equal(calls, 3);
  time = 300; fail = false; await read(); assert.equal(calls, 4);
  const empty = cachedCatalog(async () => { throw new Error("offline"); });
  await assert.rejects(empty(), /offline/);
});
