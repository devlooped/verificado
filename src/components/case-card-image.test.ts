import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageResponse } from "next/og.js";
import sharp from "sharp";
import { CaseCardImage } from "./case-card-image.tsx";
import { project, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { caseCardImageData, caseCardJpeg } from "../lib/case-card-image.ts";

const c: CaseRecord = { id: "TEST", createdAt: "2026-01-01", status: "resolved", submission: { kind: "text", text: "Submission" } };
const events: CourtEvent[] = [
  { type: "claims_entered", claims: [{ id: "A1", quote: "Claim", text: "Claim" }] },
  { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "" },
  { type: "vote", by: "gemini", claimId: "A1", verdict: "verdadero", rationale: "" },
  { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "" },
];

test("the embedded stamp includes only models that voted for the judgment", () => {
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view: project(events) }));
  assert.match(markup, /Falso/);
  assert.match(markup, /title=\"Grok\"/);
  assert.doesNotMatch(markup, /title=\"Gemini\"/);
  assert.match(markup, /rotate\(180deg\)/);
});

test("dismissed cases do not display a verdict or voters", () => {
  const view = project([...events, { type: "dismissed", reason: "No claim" }]);
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view }));
  assert.match(markup, /Descartado/);
  assert.doesNotMatch(markup, /Falso|title=\"Grok\"/);
});

test("the content verdict replaces the case number on the cover, separate from claim results", async () => {
  const view = project([...events, { type: "content_judgment", verdict: "enganoso", method: "consensus", reasoning: "" }]);
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view }));
  assert.match(markup, /Engañoso/);
  assert.match(markup, /Falso/);
  assert.doesNotMatch(markup, /Contenido completo/);
  assert.doesNotMatch(markup, /Nº TEST/);
  const response = new ImageResponse(createElement(CaseCardImage, { c, view }), { width: 720, height: 720 });
  assert.equal((await sharp(await caseCardJpeg(await response.arrayBuffer())).metadata()).format, "jpeg");
});

test("without a content judgment the cover does not turn claim outcomes into a content verdict", () => {
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view: project(events) }));
  assert.match(markup, /Nº TEST/);
  assert.doesNotMatch(markup, /Engañoso/);
});

test("PNG, JPEG, WebP and GIF covers render into the same stamped JPEG", async () => {
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const image = await caseCardImageData({ bytes });
    const response = new ImageResponse(createElement(CaseCardImage, { c, view: project(events), image }), { width: 720, height: 720 });
    const output = await caseCardJpeg(await response.arrayBuffer());
    assert.equal((await sharp(output).metadata()).format, "jpeg");
    const pixel = await sharp(output).extract({ left: 300, top: 300, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(pixel[0]! > 240 && pixel[1]! < 15 && pixel[2]! < 15, format + " cover is visible");
  }
});

test("rated questions show their answers on the cover, with the models that gave them", async () => {
  const questions: CourtEvent[] = [
    { type: "content_classified", kind: "question", items: [{ id: "P1", quote: "", text: "¿Bajó?" }, { id: "P2", quote: "", text: "¿Cuánto?" }] },
    { type: "answer_vote", by: "grok", questionId: "P1", verdict: "enganoso", rationale: "" },
    { type: "answer_vote", by: "gemini", questionId: "P1", verdict: "falso", rationale: "" },
    { type: "answer_judgment", questionId: "P1", verdict: "enganoso", method: "judge", reasoning: "" },
    { type: "answer_judgment", questionId: "P2", verdict: "enganoso", method: "consensus", reasoning: "" },
  ];
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view: project(questions) }));
  assert.match(markup, /Respuestas: Depende/);
  assert.match(markup, /title=\"Grok\"/);
  assert.match(markup, />P2</);
  assert.doesNotMatch(markup, /title=\"Gemini\"|Engañoso/);
  const response = new ImageResponse(createElement(CaseCardImage, { c, view: project(questions) }), { width: 720, height: 720 });
  assert.equal((await sharp(await caseCardJpeg(await response.arrayBuffer())).metadata()).format, "jpeg");
});

test("a Dato answer shows on the cover with its own color", () => {
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view: project([
    { type: "content_classified", kind: "question", items: [{ id: "P1", quote: "", text: "¿Cuánto mide?" }] },
    { type: "answer_vote", by: "claude", questionId: "P1", verdict: "dato", rationale: "" },
    { type: "answer_judgment", questionId: "P1", verdict: "dato", method: "consensus", reasoning: "" },
  ]) }));
  assert.match(markup, /Respuesta: Dato/);
  assert.match(markup, /background-color:#3c5ea8/);
  assert.match(markup, /title=\"Claude\"/);
});