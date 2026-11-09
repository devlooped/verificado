import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODELS, resolveModels } from "../court/models.ts";
import type { CatalogModel } from "./gateway-catalog.ts";
import { latestFamilyModels } from "./model-families.ts";
import { effortField, modelField, parseModelSettings } from "./model-settings.ts";

const catalog: CatalogModel[] = latestFamilyModels([
  { id: "google/gemini-3.5-flash-lite", name: "Flash Lite", type: "language", tags: ["structured-output", "tool-use"], efforts: ["low", "high"] },
  { id: "openai/gpt-6-luna", name: "Luna", type: "language", tags: ["structured-output", "tool-use", "vision"], efforts: ["low", "medium", "high"] },
  { id: "spacexai/grok-4.7", name: "Grok", type: "language", tags: ["structured-output", "tool-use", "vision"], efforts: ["low", "medium", "high", "xhigh"] },
  { id: "spacexai/grok-imagine-image", name: "Imagine", type: "image", tags: ["image-generation"], efforts: [] },
]);

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

test("unchanged and empty fields produce no changes", () => {
  assert.deepEqual(parseModelSettings(form({}), DEFAULT_MODELS, catalog), { ok: true, changes: [] });
  assert.deepEqual(parseModelSettings(form({ [modelField("judge")]: "spacexai/grok-4.7", [effortField("judge")]: "high" }), DEFAULT_MODELS, catalog), { ok: true, changes: [] });
});

test("a changed model and effort is validated against the catalog and saved", () => {
  const result = parseModelSettings(form({ [modelField("translator")]: " openai/gpt-6-luna ", [effortField("translator")]: "medium" }), DEFAULT_MODELS, catalog);
  assert.deepEqual(result, { ok: true, changes: [{ role: "translator", setting: { modelId: "openai/gpt-luna", effort: "medium" } }] });
});

test("returning to the default removes the override", () => {
  const current = resolveModels([{ role: "judge", modelId: "openai/gpt-6-luna", effort: "low" }]);
  const result = parseModelSettings(form({ [modelField("judge")]: "spacexai/grok-4.7", [effortField("judge")]: "high" }), current, catalog);
  assert.deepEqual(result, { ok: true, changes: [{ role: "judge", setting: null }] });
});

test("rejects unknown models, wrong kinds, missing capabilities and unsupported efforts", () => {
  const result = parseModelSettings(form({
    [modelField("counsel.grok")]: "spacexai/nonexistent-9",
    [modelField("cover.image")]: "spacexai/grok-4.7",
    [modelField("counsel.gemini")]: "google/gemini-3.5-flash-lite",
    [modelField("translator")]: "google/gemini-3.5-flash-lite",
    [effortField("translator")]: "medium",
    [modelField("language")]: "not an id",
  }), DEFAULT_MODELS, catalog);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors["counsel.grok"]!, /no está en el catálogo/);
  assert.match(result.errors["cover.image"]!, /de imagen/);
  assert.match(result.errors["counsel.gemini"]!, /vision/);
  assert.match(result.errors.translator!, /low, high/);
  assert.match(result.errors.language!, /proveedor\/modelo/);
});

test("x_search's researcher only takes Grok models, since native X search exists only there", () => {
  const rejected = parseModelSettings(form({ [modelField("research.x")]: "openai/gpt-6-luna" }), DEFAULT_MODELS, catalog);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.errors["research.x"]!, /spacexai/);
  const accepted = parseModelSettings(form({ [modelField("research.x")]: "spacexai/grok-4.7", [effortField("research.x")]: "low" }), DEFAULT_MODELS, catalog);
  assert.deepEqual(accepted, { ok: true, changes: [{ role: "research.x", setting: { modelId: "spacexai/grok", effort: "low" } }] });
});

test("without a catalog only the ID format is checked, and image roles ignore effort", () => {
  const result = parseModelSettings(form({ [modelField("cover.image")]: "google/imagen-9", [effortField("cover.image")]: "high" }), DEFAULT_MODELS);
  assert.deepEqual(result, { ok: true, changes: [{ role: "cover.image", setting: { modelId: "google/imagen", effort: null } }] });
});

test("the same family can offer both language and image models", () => {
  const mixed = latestFamilyModels([
    { id: "openai/example-1", name: "language", type: "language", tags: [], efforts: [] },
    { id: "openai/example-2", name: "image", type: "image", tags: [], efforts: [] },
  ]);
  const result = parseModelSettings(form({ [modelField("translator")]: "openai/example" }), DEFAULT_MODELS, mixed);
  assert.deepEqual(result, { ok: true, changes: [{ role: "translator", setting: { modelId: "openai/example", effort: null } }] });
});
