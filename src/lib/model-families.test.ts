import assert from "node:assert/strict";
import test from "node:test";
import { latestFamilyModels, latestModel, modelFamily } from "./model-families.ts";
import type { CatalogModel } from "./gateway-catalog.ts";

const model = (id: string, type = "language", efforts: string[] = []): CatalogModel => ({ id, name: id, type, tags: [], efforts });

test("removes versions while retaining all flavor words and providers", () => {
  for (const [id, family] of [
    ["anthropic/claude-opus-4.7", "anthropic/opus"],
    ["anthropic/opus-4.7", "anthropic/opus"],
    ["google/gemini-4-argon", "google/gemini-argon"],
    ["google/gemini-3.5-flash-lite", "google/gemini-flash-lite"],
    ["deepseek/deepseek-v4.1-flash-1017-fast", "deepseek/deepseek-flash-fast"],
    ["openai/gpt-4o-mini", "openai/gpt-o-mini"],
    ["alibaba/qwen3-coder-30b-a3b", "alibaba/qwen-coder-30b-a3b"],
    ["moonshotai/kimi-k2.5", "moonshotai/kimi-k"],
    ["zai/glm-4.5v", "zai/glm-v"],
    ["openai/o3-mini", "openai/o-mini"],
    ["anthropic/claude-3-7-sonnet", "anthropic/sonnet"],
    ["spacexai/grok-imagine-image-2.0", "spacexai/grok-imagine-image"],
    ["google/gemini-flash", "google/gemini-flash"],
  ]) assert.equal(modelFamily(id!), family);
});

test("numeric versions, revisions and flavors determine the latest model, independent of order", () => {
  const catalog = [
    model("deepseek/deepseek-v4.9-flash", "language", ["low"]),
    model("deepseek/deepseek-v4.10-flash", "language", ["high"]),
    model("deepseek/deepseek-v4.10-flash-1017", "language", ["max"]),
    model("deepseek/deepseek-v4-flash-0731"),
    model("deepseek/deepseek-v9-pro"), model("deepseek/deepseek-v9-flash-fast"),
    model("anthropic/claude-opus-4.7"), model("anthropic/claude-opus-5.5"),
    model("anthropic/claude-opus-5.5-fast"), model("anthropic/claude-opus"),
  ];
  assert.equal(latestModel("deepseek/deepseek-v4-flash", catalog)?.id, "deepseek/deepseek-v4.10-flash-1017");
  assert.equal(latestModel("deepseek/deepseek-flash", [model("deepseek/deepseek-v4-flash-0731"), model("deepseek/deepseek-v4.1-flash")])?.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(latestModel("alibaba/qwen-coder", [model("alibaba/qwen3-coder"), model("alibaba/qwen3.5-coder")])?.id, "alibaba/qwen3.5-coder");
  assert.equal(latestModel("openai/gpt-o-mini", [model("openai/gpt-4o-mini"), model("openai/gpt-5-mini")])?.id, "openai/gpt-4o-mini");
  assert.equal(latestModel("deepseek/deepseek-flash-fast", catalog)?.id, "deepseek/deepseek-v9-flash-fast");
  assert.equal(latestModel("anthropic/claude-opus-4.7", catalog)?.id, "anthropic/claude-opus-5.5");
  assert.equal(latestModel("anthropic/opus-4.7", catalog)?.id, "anthropic/claude-opus-5.5");
  assert.equal(latestModel("anthropic/claude-opus-fast", catalog)?.id, "anthropic/claude-opus-5.5-fast");
  assert.equal(latestModel("other/claude-opus", catalog), undefined);
  const families = latestFamilyModels(catalog);
  assert.equal(families.find((m) => m.id === "deepseek/deepseek-flash")?.efforts[0], "max");
  assert.equal(families.filter((m) => m.id === "deepseek/deepseek-flash").length, 1);
  assert.ok(families.every((m) => m.id === modelFamily(m.id) && m.name === m.id));
  assert.deepEqual(latestFamilyModels([model("test/model-1"), model("test/model-2", "image")]).map((m) => m.type).sort(), ["image", "language"]);
});
