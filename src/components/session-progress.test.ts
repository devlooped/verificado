import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CourtEvent } from "../domain/court.ts";
import { PROGRESS_STEPS, QUESTIONS_PROGRESS_STEPS, QUICK_PROGRESS_STEPS, quickStage, SessionProgress, sessionStage } from "./session-progress.tsx";

const claims: CourtEvent = { type: "claims_entered", claims: [{ id: "A1", quote: "q", text: "t" }, { id: "A2", quote: "r", text: "u" }] };

test("the stage is the furthest one the recorded events reached", () => {
  assert.equal(sessionStage([]), 0);
  assert.equal(sessionStage([{ type: "session_opened" }, claims, { type: "instruction_opened" }]), 0);
  assert.equal(sessionStage([claims, { type: "source_collection_started" }]), 1);
  assert.equal(sessionStage([{ type: "source_batch_started" }]), 1);
  assert.equal(sessionStage([{ type: "source_batch_completed" }, { type: "evidence_unified" }]), 2);
  assert.equal(sessionStage([{ type: "evidence_unified" }, { type: "statement" }]), 3);
  assert.equal(sessionStage([{ type: "statement" }, { type: "vote" }, { type: "absence" }]), 4);
});

test("the progress marks the current stage and says how many claims are under study", () => {
  const events: CourtEvent[] = [claims, { type: "evidence_unified", sources: [] }];
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events, queued: false, collectionProgress: true })));
  const steps = [...document.querySelectorAll("ol li")];
  assert.equal(steps.length, PROGRESS_STEPS.length);
  assert.equal(steps.findIndex((li) => li.getAttribute("aria-current") === "step"), 2);
  assert.match(document.querySelector('[role="status"]')!.textContent, /Etapa 3 de 5: Crítica de fuentes/);
  assert.match(document.toString(), /2 afirmaciones en estudio/);
});

test("collection progress displays consulted counts and legacy cases keep their original stages", () => {
  const events: CourtEvent[] = [claims, { type: "source_collection_started", total: 5, batches: 2 }, { type: "source_batch_completed", batch: 1, batches: 2, count: 4, completed: 4, total: 5, failed: 1 }];
  const document = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events, queued: false, collectionProgress: true }))).document;
  assert.match(document.querySelector('[role="status"]')!.textContent, /Etapa 2 de 5: Fuentes/);
  assert.match(document.toString(), /Enlaces consultados: 4 de 5/);
  const legacy = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events: [claims, { type: "evidence_unified", sources: [] }], queued: false }))).document;
  assert.equal(legacy.querySelectorAll("ol li").length, 4);
  assert.match(legacy.querySelector('[role="status"]')!.textContent, /Etapa 2 de 4: Crítica de fuentes/);
});

test("a Quick check shows two stages: the answers, then the result", () => {
  assert.equal(quickStage([{ type: "session_opened" }, { type: "quick_response" }]), 0);
  assert.equal(quickStage([{ type: "quick_response" }, { type: "content_vote" }]), 1);
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events: [{ type: "session_opened", judgeModel: "j", counselModels: { grok: "g", gemini: "m", claude: "c", chatgpt: "o" } }], queued: false, check: "quick" })));
  const steps = [...document.querySelectorAll("ol li")];
  assert.equal(steps.length, QUICK_PROGRESS_STEPS.length);
  assert.match(document.querySelector('[role="status"]')!.textContent, /Etapa 1 de 2: Respuestas/);
  assert.match(document.toString(), /Los analistas están respondiendo/);
  assert.doesNotMatch(document.toString(), /moderador está identificando/);
});

test("a queued case shows no current stage", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events: [], queued: true })));
  assert.equal(document.querySelector('[aria-current="step"]'), null);
  assert.match(document.toString(), /en espera/);
});

test("optional Quick claims add identification before answers and individual votes advance to results", () => {
  assert.equal(quickStage([], true), 0);
  assert.equal(quickStage([claims], true), 1);
  assert.equal(quickStage([claims, { type: "vote" }], true), 2);
  const render = (events: CourtEvent[], queued = false) => parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events, queued, check: "quick", identifyClaims: true }))).document;
  assert.match(render([]).querySelector('[role="status"]')!.textContent!, /Etapa 1 de 3: Afirmaciones/);
  assert.match(render([]).toString(), /moderador está identificando/);
  assert.match(render([claims]).querySelector('[role="status"]')!.textContent!, /Etapa 2 de 3: Respuestas/);
  assert.equal(render([], true).querySelector('[aria-current="step"]'), null);
});

test("questions progress from the answers to the moderator's synthesis, without a result stage", () => {
  const classified: CourtEvent = { type: "content_classified", kind: "questions" };
  const progress = (events: CourtEvent[]) => parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events, queued: false, check: "quick", identifyClaims: true }))).document;
  const answering = progress([classified]);
  assert.deepEqual([...answering.querySelectorAll("ol li")].map((li) => li.textContent?.replace(/\s*\(.*\)$/, "")), [...QUESTIONS_PROGRESS_STEPS]);
  assert.match(answering.querySelector('[role="status"]')!.textContent, /Etapa 1 de 2: Respuestas/);
  assert.match(answering.toString(), /Los analistas están respondiendo las preguntas/);
  const synthesizing = progress([classified, { type: "quick_response", by: "grok", text: "Respuesta", sources: [] }]);
  assert.match(synthesizing.querySelector('[role="status"]')!.textContent, /Etapa 2 de 2: Síntesis/);
  assert.match(synthesizing.toString(), /El moderador está sintetizando las respuestas/);
  assert.doesNotMatch(synthesizing.toString(), /Resultado|Afirmaciones|votando/);
});
