import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ProcessDiagram, PROCESS_DIAGRAM } from "./process-diagram.tsx";
import MethodPage from "./page.tsx";

test("the diagram shows the classification, the questions path without rating, and the vote, majority, tiebreak and failure paths", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(ProcessDiagram)));
  const region = document.querySelector('[role="region"]');
  const svg = region?.querySelector("svg.pele-flowchart");
  assert.ok(svg);
  assert.equal(svg.querySelector("title")?.textContent, "El proceso de un chequeo");
  assert.match(svg.querySelector("desc")?.textContent ?? "", /menos de tres votos o si falla el desempate no hay resultado/);
  assert.match(svg.querySelector("desc")?.textContent ?? "", /las preguntas no se califican/);
  assert.match(region?.getAttribute("aria-label") ?? "", /chequeo/);
  assert.equal(region?.getAttribute("tabindex"), "0");
  for (const text of [
    "¿afirmaciones o preguntas?",
    "y responden las preguntas",
    "¿Respondieron al menos 3?",
    "Sin síntesis",
    "la opinión mayoritaria",
    "las posiciones de los analistas",
    "Sin calificación de las preguntas",
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
  for (const edge of ["Q -- Preguntas --> R", "S -- No --> T", "U -- Sí --> V", "U -- No --> W", "Q -- Afirmaciones --> O", "O -- Sí --> P", "O -- No --> B", "P --> B", "E -- Sí --> F", "F --> L", "M -- No --> H", "E -- No --> G", "G -- No --> H", "G -- Sí --> I", "J -- No --> H"]) {
    assert.ok(PROCESS_DIAGRAM.includes(edge), edge);
  }
});

test("the method page explains one check, after the four possible results, and never the Expert check", () => {
  // One root, so that the whole page is the document element.
  const page = parseHTML("<main>" + renderToStaticMarkup(createElement(MethodPage)) + "</main>").document;
  const text = page.documentElement.textContent ?? "";
  assert.doesNotMatch(text, /reintent|administrador|\badmin\b|\bcontrib\b/i);
  assert.doesNotMatch(text, /expert|instrucción|crítica de fuentes y debate/i);
  assert.match(text, /no se votan ni se califican/);
  const sections = [...page.querySelectorAll("main section, section")];
  const results = sections.findIndex((section) => section.id === "resultados");
  const process = sections.findIndex((section) => section.id === "proceso");
  assert.ok(results >= 0 && process > results);
  const diagrams = [...sections[process]!.querySelectorAll("svg.pele-flowchart")];
  assert.deepEqual(diagrams.map((svg) => svg.querySelector("title")?.textContent), ["El proceso de un chequeo"]);
});
