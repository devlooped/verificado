import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_ROLE } from "../court/models.ts";
import { latestFamilyModels, modelFamily } from "../lib/model-families.ts";
import { ModelSettingsForm, type ModelRow } from "./model-settings-form.tsx";

test("ModelSettingsForm offers searchable catalog IDs, the defaults and the efforts of the chosen model", () => {
  const rows: ModelRow[] = [
    { ...MODEL_ROLE.translator, defaultId: modelFamily(MODEL_ROLE.translator.defaultId), modelId: "google/gemini-flash-lite", effort: null, overridden: false },
    { ...MODEL_ROLE.judge, defaultId: modelFamily(MODEL_ROLE.judge.defaultId), modelId: "openai/gpt-luna", effort: "low", overridden: true },
    { ...MODEL_ROLE["cover.image"], defaultId: modelFamily(MODEL_ROLE["cover.image"].defaultId), modelId: "spacexai/grok-imagine-image", effort: null, overridden: false },
  ];
  const html = renderToStaticMarkup(createElement(ModelSettingsForm, { rows, catalog: latestFamilyModels([
    { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", type: "language", tags: [], efforts: ["low", "high"] },
    { id: "openai/gpt-6-luna", name: "Luna", type: "language", tags: [], efforts: ["low", "medium", "high"] },
    { id: "spacexai/grok-imagine-image-2.0", name: "Imagine", type: "image", tags: [], efforts: [] },
  ]) }));
  assert.match(html, /<datalist id="gateway-models-language"><option value="google\/gemini-flash-lite">google\/gemini-flash-lite<\/option><option value="openai\/gpt-luna">openai\/gpt-luna<\/option><\/datalist>/);
  assert.match(html, /<datalist id="gateway-models-image"><option value="spacexai\/grok-imagine-image">/);
  assert.match(html, /<input id="translator:model" list="gateway-models-language"[^>]*value="google\/gemini-flash-lite"/);
  assert.match(html, /Predeterminado: spacexai\/grok · esfuerzo high/);
  assert.match(html, /personalizado/);
  // The image role has no effort selector.
  assert.doesNotMatch(html, /name="cover.image:effort"/);
  const judgeEfforts = /name="judge:effort"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
  assert.match(judgeEfforts, /value="medium"/);
  const translatorEfforts = /name="translator:effort"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
  assert.doesNotMatch(translatorEfforts, /value="medium"/);
});

test("a read-only ModelSettingsForm shows the configuration without any way to change it", () => {
  const rows: ModelRow[] = [
    { ...MODEL_ROLE.judge, defaultId: modelFamily(MODEL_ROLE.judge.defaultId), modelId: "openai/gpt-luna", effort: "low", overridden: true },
  ];
  const html = renderToStaticMarkup(createElement(ModelSettingsForm, { rows, catalog: [], readOnly: true }));
  assert.match(html, /<input id="judge:model"[^>]*readOnly=""[^>]*value="openai\/gpt-luna"|<input id="judge:model"[^>]*value="openai\/gpt-luna"[^>]*readOnly=""/);
  assert.match(html, /<select name="judge:effort" disabled=""/);
  assert.doesNotMatch(html, /type="submit"|Guardar|Restablecer/);
  assert.match(html, /personalizado/);
});
