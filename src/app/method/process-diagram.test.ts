import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ProcessDiagram, QuickProcessDiagram, QUICK_PROCESS_DIAGRAM } from "./process-diagram.tsx";
import MethodPage from "./page.tsx";

const html = renderToStaticMarkup(createElement(ProcessDiagram));
const { document } = parseHTML(html);

test("the process is rendered as an accessible Pele diagram", () => {
  const region = document.querySelector('[role="region"]');
  const svg = region?.querySelector("svg.pele-flowchart");
  assert.ok(svg);
  assert.equal(svg.querySelector("title")?.textContent, "El proceso de un chequeo experto");
  assert.match(svg.querySelector("desc")?.textContent ?? "", /crítica de fuentes/);
  for (const text of [
    "Se cierra la instrucción",
    "Expediente común sin fuentes",
    "Fuente anulada",
    "Fuente admitida",
    "Se anula la intervención objetada",
    "Resultado por mayoría",
    "El moderador desempata",
    "Termina el debate",
  ]) assert.ok(svg.textContent?.replace(/\s/g, "").includes(text.replace(/\s/g, "")), text);
  assert.ok(!svg.textContent?.replace(/\s/g, "").includes("Secierraelexpediente"));
  assert.equal(region?.getAttribute("tabindex"), "0");
});

test("the quick diagram shows the independent vote, majority, tiebreak and failure paths", () => {
  const quick = parseHTML(renderToStaticMarkup(createElement(QuickProcessDiagram))).document;
  const region = quick.querySelector('[role="region"]');
  const svg = region?.querySelector("svg.pele-flowchart");
  assert.ok(svg);
  assert.equal(svg.querySelector("title")?.textContent, "El proceso de un chequeo rápido");
  assert.match(svg.querySelector("desc")?.textContent ?? "", /menos de tres votos o si falla el desempate no hay resultado/);
  assert.match(region?.getAttribute("aria-label") ?? "", /chequeo rápido/);
  assert.equal(region?.getAttribute("tabindex"), "0");
  for (const text of [
    "Los cuatro analistas investigan en paralelo",
    "¿Identificar afirmaciones independientes?",
    "separa hasta cinco afirmaciones",
    "y cada afirmación, si se eligió",
    "Por cada resultado:",
    "contenido completo con fundamentos",
    "Resultado por mayoría",
    "El moderador resume los fundamentos",
    "¿Hay al menos 3 votos?",
    "Sin resultado",
    "las respuestas y los votos, sin investigar",
    "Resultado con fundamento del moderador",
  ]) assert.ok(svg.textContent?.replace(/\s/g, "").includes(text.replace(/\s/g, "")), text);
  for (const edge of ["O -- Sí --> P", "O -- No --> B", "P --> B", "E -- Sí --> F", "F --> L", "M -- No --> H", "E -- No --> G", "G -- No --> H", "G -- Sí --> I", "J -- No --> H"]) {
    assert.ok(QUICK_PROCESS_DIAGRAM.includes(edge), edge);
  }
});

test("the process diagram follows the four possible results on the method page", () => {
  const page = parseHTML(renderToStaticMarkup(createElement(MethodPage))).document;
  assert.doesNotMatch(page.documentElement.textContent ?? "", /reintent|administrador|\badmin\b|\bcontrib\b/i);
  const sections = [...page.querySelectorAll("main section, section")];
  const results = sections.findIndex((section) => section.id === "resultados");
  const process = sections.findIndex((section) => section.id === "proceso");
  assert.ok(results >= 0 && process > results);
  const diagrams = [...sections[process]!.querySelectorAll("svg.pele-flowchart")];
  assert.deepEqual(diagrams.map((svg) => svg.querySelector("title")?.textContent), [
    "El proceso de un chequeo rápido",
    "El proceso de un chequeo experto",
  ]);
  const ids = [...sections[process]!.querySelectorAll("[id]")].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length, "the two diagrams must not share SVG ids");
});
