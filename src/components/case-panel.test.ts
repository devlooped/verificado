import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seatModels, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { CasePanel } from "./case-panel.tsx";

const record: CaseRecord = {
  id: "test", createdAt: "2026-11-04", status: "resolved", submission: { kind: "text", text: "Una afirmación" },
  models: {
    judge: { id: "anthropic/claude-opus-5.5", effort: "high" },
    "counsel.grok": { id: "openai/gpt-6.1-sol", effort: "high" },
    "counsel.gemini": { id: "google/gemini-4-argon", effort: null },
    "image.description": { id: "openai/vision", effort: "high" },
    language: { id: "anthropic/haiku", effort: null },
    translator: { id: "google/flash", effort: null },
    "research.x": { id: "spacexai/grok-4.7", effort: null },
    "cover.chooser": { id: "spacexai/chooser", effort: null },
    "cover.check": { id: "anthropic/check", effort: null },
    "cover.image": { id: "spacexai/image", effort: null },
    "tier.evaluator": { id: "openai/evaluator", effort: null },
  },
};

function render(c: CaseRecord, events: CourtEvent[] = []) {
  return renderToStaticMarkup(createElement(CasePanel, { c, models: seatModels(c, events) }));
}

test("the panel introduces the snapshot's moderator, seats and support roles without inventing their use", () => {
  const { document } = parseHTML(render(record));
  const panel = document.querySelector("section")!;
  assert.equal(panel.querySelector("h2")?.textContent, "Panel");
  assert.ok(!panel.textContent.includes("Configuración al inicio del caso"));
  assert.ok(panel.textContent.includes("Las funciones de apoyo se usan cuando hacen falta"));
  assert.ok(panel.textContent.includes("Moderador:Claude"));
  const analysts = panel.querySelector("dl > div.border-t dd")!;
  assert.deepEqual([...analysts.querySelectorAll("[title]")].map((model) => model.textContent), ["ChatGPT", "Gemini"], "list the configured models, including a model whose provider differs from its seat");
  assert.ok(analysts.textContent.includes("gpt-6.1-sol high"), "the exact model and effort are visible without hovering");
  assert.ok(panel.querySelector("details > summary")?.textContent.includes("Modelos de apoyo"));
  assert.ok(!panel.querySelector("details")?.hasAttribute("open"), "optional support stays folded for a quick scan");
  assert.ok(!panel.textContent.includes("Analista Grok:"));
  assert.ok(panel.querySelector('[title="claude-opus-5.5 high"] svg line'), "the moderator's mark follows the snapshot");
  assert.ok(panel.querySelector('[title="gpt-6.1-sol high"]'));
  for (const role of ["Detección de idioma", "Traductor", "Búsqueda en X", "Portada: búsqueda", "Portada: revisión", "Portada: ilustración"]) assert.ok(panel.textContent.includes(role), role);
  assert.ok(!panel.textContent.includes("Descripción de imágenes"));
  assert.ok(!panel.textContent.includes("Evaluador de nivel"));
});

test("the analyst list handles missing seats without stray separators or an empty label", () => {
  const one = { ...record, models: { "counsel.claude": { id: "anthropic/claude-opus-5.5", effort: "high" } } };
  const onePanel = parseHTML(render(one)).document.querySelector("section")!;
  assert.ok(onePanel.textContent.includes("Analistas:Claude"));
  assert.ok(!onePanel.textContent.includes("Analistas:,"));
  assert.ok(!onePanel.textContent.includes("Claude,"));
  const noAnalysts = { ...record, models: { judge: record.models!.judge! } };
  assert.ok(!parseHTML(render(noAnalysts)).document.querySelector("section")!.textContent.includes("Analistas:"));
});

test("image cases include image description in support", () => {
  const html = render({ ...record, submission: { kind: "image", mimeType: "image/png" } });
  assert.match(html, /Descripción de imágenes/);
  assert.match(html, /title="vision high"/);
});

test("older cases use opening-event seats without inventing support models", () => {
  const c = { ...record, models: undefined };
  const event: CourtEvent = { type: "session_opened", judgeModel: "google/gemini-4-argon", judgeEffort: "high", counselModels: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" } };
  const { document } = parseHTML(render(c, [event]));
  assert.ok(document.querySelector('[title="gemini-4-argon high"]'));
  assert.deepEqual([...document.querySelectorAll("dl > div.border-t dd [title]")].map((model) => model.textContent), ["Grok", "Gemini", "Claude", "ChatGPT"]);
  assert.ok(!document.querySelector("h3"), "no support configuration was recorded");
  assert.equal(render(c), "", "do not introduce unknown models");
});

test("the panel names what the panel did, never the disabled Expert check", () => {
  assert.match(render(record), />Chequeo</);
  assert.doesNotMatch(render(record), /experto|rápido/i);
  assert.match(renderToStaticMarkup(createElement(CasePanel, { c: record, models: seatModels(record), label: "Consulta" })), />Consulta</);
});
