import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { displayHistoricalCitations } from "../domain/historical-citations.ts";
import { caseCosts } from "../domain/cost.ts";
import { CaseResult } from "./case-result.tsx";
import { Case } from "./case.tsx";

const c: CaseRecord = {
  id: "fixture", createdAt: "2026-10-30T14:00:00.000Z", status: "resolved",
  submission: { kind: "text", text: "Primera afirmación. Segunda afirmación." },
  models: { judge: { id: "anthropic/claude-opus-5.5", effort: "high" }, "counsel.chatgpt": { id: "openai/gpt-6.1-sol", effort: "high" } },
};
const events: CourtEvent[] = [
  { type: "claims_entered", claims: [
    { id: "A1", quote: "Primera afirmación", text: "Primera afirmación examinada" },
    { id: "A2", quote: "Segunda afirmación", text: "Segunda afirmación examinada" },
  ] },
  ...COUNSEL.map((by, i): CourtEvent => ({ type: "vote", by, claimId: "A1", verdict: i === 0 ? "verdadero" : "falso", rationale: "Fundamento de " + by })),
  { type: "vote", by: "gemini", claimId: "A2", verdict: "no_verificable", rationale: "La evidencia no alcanza." },
  { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
  { type: "judgment", claimId: "A2", verdict: "no_verificable", method: "judge", reasoning: "El expediente es insuficiente." },
  { type: "case_summary", text: "El debate discutió el alcance de las pruebas. Los analistas discreparon." },
  { type: "session_closed" },
];

function render(input: CourtEvent[], record: CaseRecord = c) {
  return renderToStaticMarkup(createElement(CaseResult, { c: record, view: project(input) }));
}

test("the original material displays the creation date in the case language", () => {
  for (const [language, expected] of [["es", "30 de octubre de 2026"], ["en", "October 30, 2026"]] as const) {
    const record: CaseRecord = { ...c, submission: { ...c.submission, resolvedLanguage: language } };
    const { document } = parseHTML(render(events, record));
    const date = document.querySelector("figure time")!;
    assert.equal(date.getAttribute("dateTime"), "2026-10-30");
    assert.equal(date.textContent, expected);
    assert.match(date.parentElement!.textContent!, /^ - /);
    assert.match(document.querySelector("figure blockquote")!.textContent!, /Primera afirmación/);
  }
  for (const submission of [
    { kind: "link" as const, url: "https://example.test", resolvedLanguage: "en" },
    { kind: "image" as const, mimeType: "image/png", resolvedLanguage: "en" },
  ]) {
    const { document } = parseHTML(render([], { ...c, submission }));
    assert.equal(document.querySelector("figure time")!.textContent, "October 30, 2026");
  }
});

test("a Quick check with independent claims displays their results and a separate overall vote", () => {
  const quick: CaseRecord = { ...c, submission: { ...c.submission, check: "quick", identifyClaims: true } };
  const input: CourtEvent[] = [...events.filter((e) => e.type !== "case_summary"),
    ...COUNSEL.map((by): CourtEvent => ({ type: "content_vote", by, verdict: "enganoso", rationale: "Fundamento global de " + by })),
    { type: "content_judgment", verdict: "enganoso", method: "consensus", reasoning: "" },
  ];
  const { document } = parseHTML(render(input, quick));
  assert.match(document.querySelector("figure figcaption")!.textContent!, /Chequeo Rápido/);
  assert.equal(document.querySelectorAll("[data-claim]").length, 2);
  assert.ok(document.querySelector('[aria-label="Resultado del contenido completo: Engañoso"]'));
  assert.ok(document.querySelector('[aria-label="Votos de los analistas sobre A1"]'));
  assert.ok(document.querySelector('[aria-label="Votos de los analistas sobre el contenido"]'));
  assert.match(document.querySelector("#case-claims-title")!.textContent!, /Afirmaciones/);
});

test("the result renders costs only when supplied, including cases with no recorded usage", () => {
  const view = project(events);
  const withoutCosts = renderToStaticMarkup(createElement(CaseResult, { c, view }));
  assert.doesNotMatch(withoutCosts, /Costo|no tiene uso de tokens registrado/);
  const withCosts = renderToStaticMarkup(createElement(CaseResult, { c, view, costs: caseCosts([], {}) }));
  assert.match(withCosts, /Costo/);
  assert.match(withCosts, /no tiene uso de tokens registrado/);
});

test("the content, panel and claims form an overview immediately before the moderator summary", () => {
  const html = render(events);
  const { document } = parseHTML(html);
  const overview = document.querySelector("[data-case-overview]")!;
  assert.equal(overview.querySelector("figure figcaption")?.textContent, "Chequeo Experto");
  assert.ok(overview.querySelector("figure figcaption svg"), "the content has a margin icon");
  assert.ok(overview.querySelector('[aria-labelledby="case-panel-title"] svg'), "the panel has a margin icon");
  assert.equal(overview.querySelectorAll("article[data-claim]").length, 2);
  assert.ok(overview.querySelector('[aria-labelledby="case-claims-title"] svg'), "the claims have a margin icon");
  assert.equal(overview.nextElementSibling?.getAttribute("aria-labelledby"), "case-summary-title");
  assert.ok(html.indexOf('id="A1"') < html.indexOf("Resumen del caso"));
  assert.equal((html.match(/Resumen del caso/g) ?? []).length, 1);
  assert.equal(document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent, "Por el moderador");
  assert.ok(html.includes("El debate discutió el alcance de las pruebas."));
  assert.ok(html.includes("Los analistas discreparon."));
  assert.ok(html.includes("Fundamentos de cada voto"));
});

test("the content card shows its own verdict and transparent votes without changing the claim aggregate", () => {
  const input: CourtEvent[] = [...events,
    { type: "content_vote", by: "grok", verdict: "enganoso", rationale: "La narrativa omite contexto." },
    { type: "content_vote", by: "gemini", verdict: null, rationale: "Son afirmaciones independientes." },
    { type: "content_judgment", verdict: "enganoso", method: "judge", reasoning: "El contexto completo cambia el sentido." },
  ];
  const { document } = parseHTML(render(input));
  const figure = document.querySelector("figure")!;
  assert.equal(figure.querySelector('[aria-label="Resultado del contenido completo: Engañoso"]')?.textContent?.trim(), "Engañoso");
  assert.ok(figure.textContent.includes("La narrativa omite contexto"));
  assert.ok(figure.textContent.includes("No corresponde"));
  assert.ok(figure.textContent.includes("Desempate del moderador"));
  assert.equal(figure.querySelector("summary")?.textContent, "Evaluaciones del contenido completo");
  assert.equal(figure.querySelector('[aria-label="Votos de los analistas sobre el contenido"]'), null);
  assert.ok(document.querySelector('[aria-label="Resultado de afirmaciones: Mixto"]'));
});

test("a historical unanimous summary shows the reported content verdict without invented individual votes", () => {
  const input: CourtEvent[] = [...events.filter((e) => e.type !== "case_summary"), { type: "case_summary", text: "Los cuatro analistas coincidieron en considerar engañoso el enunciado completo." }];
  const { document } = parseHTML(render(input));
  const figure = document.querySelector("figure")!;
  assert.ok(figure.querySelector('[aria-label="Resultado del contenido completo: Engañoso"]'));
  assert.ok(figure.textContent.includes("Consenso informado en el"));
  assert.equal(figure.querySelector("details"), null);
});

test("a text submission identical to its sole claim shares one card with the result, votes and reasons", () => {
  const text = "Una afirmación verificable.";
  const input: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: text, text }] },
    ...events.slice(1).filter((event) => !("claimId" in event) || event.claimId === "A1"),
  ];
  const { document } = parseHTML(render(input, { ...c, submission: { kind: "text", text } }));
  const card = document.getElementById("A1")!;
  assert.equal(document.querySelectorAll("article[data-claim]").length, 1);
  assert.equal(card.querySelector("figure")?.closest("article"), card);
  assert.equal(card.querySelector("figcaption")?.textContent, "Chequeo ExpertoA1");
  assert.equal(card.textContent.split(text).length - 1, 1, "the claim's text appears only once");
  assert.ok(!card.querySelector("h3"));
  assert.ok(!card.querySelector("blockquote a"), "no duplicate inline result or vote tooltip");
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.ok(card.textContent.includes("Falso"));
  assert.ok(card.textContent.includes("Mayoría · 3 de 4"));
  assert.equal(card.querySelectorAll('[role="group"] a').length, COUNSEL.length);
  for (const by of COUNSEL) {
    assert.ok(card.querySelector('a[href="#voto-A1-' + by + '"]'));
    assert.equal(document.getElementById("voto-A1-" + by)?.closest("details")?.id, "fundamentos-A1");
  }
  assert.equal(document.querySelector("[data-case-overview]")?.nextElementSibling?.getAttribute("aria-labelledby"), "case-summary-title");
});

test("matching a sole claim ignores surrounding quotation marks and terminal punctuation but does not invent a result", () => {
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: "Única afirmación", text: "Única afirmación" }] }];
  const { document } = parseHTML(render(input, { ...c, models: undefined, submission: { kind: "text", text: "  «Única afirmación.» " } }));
  const card = document.getElementById("A1")!;
  assert.ok(card.querySelector("figure"));
  assert.ok(card.textContent.includes("Sin resultado registrado"));
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.equal(card.querySelectorAll('[role="group"] a').length, 0);
});

test("a sole claim with different wording remains separate even if it quotes the entire content", () => {
  const text = "Única afirmación.";
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text: "Afirmación reformulada por el panel." }] }];
  const { document } = parseHTML(render(input, { ...c, submission: { kind: "text", text } }));
  assert.ok(!document.querySelector("figure")?.closest("article"));
  assert.equal(document.getElementById("A1")?.querySelector("h3")?.textContent, "Afirmación reformulada por el panel.");
  assert.ok(document.querySelector('[aria-labelledby="case-claims-title"]'));
});

test("links, images and multiple claims do not combine with the original content", () => {
  const text = "Comentario";
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text }] }];
  for (const submission of [
    { kind: "link" as const, url: "https://example.org", note: text },
    { kind: "image" as const, mimeType: "image/png", note: text },
  ]) {
    const { document } = parseHTML(render(input, { ...c, submission }));
    assert.ok(!document.querySelector("figure")?.closest("article"));
    assert.ok(document.querySelector('[aria-labelledby="case-claims-title"]'));
  }
  const multiple: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text }, { id: "A2", quote: "", text: "Otra afirmación" }] }];
  const { document } = parseHTML(render(multiple, { ...c, submission: { kind: "text", text } }));
  assert.ok(!document.querySelector("figure")?.closest("article"));
  assert.equal(document.querySelectorAll("article[data-claim]").length, 2);
});

test("every visible vote links to its own folded reason, with missing votes left unlinked", () => {
  const { document } = parseHTML(render(events));
  for (const id of ["A1", "A2"]) {
    const card = document.getElementById(id)!;
    const votes = card.querySelector('[role="group"]')!;
    assert.equal(votes.children.length, COUNSEL.length);
    assert.ok(!card.querySelector("details")?.hasAttribute("open"));
    for (const link of votes.querySelectorAll("a")) {
      const target = document.getElementById(link.getAttribute("href")!.slice(1));
      assert.equal(target?.closest("article"), card);
      assert.match(link.getAttribute("aria-label") ?? "", /Ver fundamento/);
    }
  }
  const partial = document.getElementById("A2")!;
  assert.equal(partial.querySelectorAll('[role="group"] a').length, 1);
  assert.ok(partial.querySelector('[role="group"] > [aria-label="Grok: no votó"]'));
  assert.ok(document.getElementById("A1")!.textContent.includes("Mayoría · 3 de 4"));
  assert.ok(partial.textContent.includes("Desempate del moderador"));
});

test("the overview shows a mixed or shared overall result without combining analysts' votes across claims", () => {
  const mixed = parseHTML(render(events)).document;
  assert.ok(mixed.querySelector('[aria-label="Resultado general: Mixto"]'));
  const shared = events.map((e): CourtEvent => e.type === "judgment" ? { ...e, verdict: "falso" } : e);
  const same = parseHTML(render(shared)).document;
  assert.ok(same.querySelector('[aria-label="Resultado general: Falso"] .bg-falso'));
  assert.ok(!same.querySelector('[aria-label="Resultado general: Mixto"]'));
  const pending = parseHTML(render([events[0]!])).document;
  assert.ok(!pending.querySelector('[aria-label^="Resultado general:"]'));
});

test("unresolved historical claims remain visible without an invented verdict or an empty panel", () => {
  const { document } = parseHTML(render([events[0]!], { ...c, models: undefined }));
  assert.ok(!document.querySelector('[aria-labelledby="case-panel-title"]'));
  assert.equal(document.querySelectorAll("article[data-claim]").length, 2);
  assert.ok(document.getElementById("A1")!.textContent.includes("Sin resultado registrado"));
  assert.equal(document.querySelectorAll('article [role="group"] a').length, 0);
  assert.ok(!document.querySelector('[aria-labelledby="case-summary-title"]'));
});

test("dismissal retains the original and panel without rendering a claims card", () => {
  const { document } = parseHTML(render([{ type: "dismissed", reason: "No hay afirmaciones verificables." }]));
  const overview = document.querySelector("[data-case-overview]")!;
  assert.ok(overview.querySelector("figure blockquote"));
  assert.ok(overview.querySelector('[aria-labelledby="case-panel-title"]'));
  assert.ok(overview.textContent.includes("No hay afirmaciones verificables."));
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.ok(!document.querySelector('[aria-labelledby="case-summary-title"]'));
});

test("the summary links the claims, sources and interventions it mentions", () => {
  const record: CourtEvent[] = [
    events[0]!,
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "statement", id: "I3", by: "claude", stage: "rebuttal", text: "Réplica con su fundamento.", evidenceIds: ["S1"] },
    { type: "case_summary", text: "A1 es falsa según la PF (S1); Claude lo precisó en I3. S9 no existe." },
  ];
  const recorded = record.map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(CaseResult, { c, view: project(recorded), events: recorded })));
  const summary = [...document.querySelectorAll("section p")].find((p) => p.textContent.includes("según la PF"))!;
  assert.deepEqual([...summary.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#A1", "#S1", "#I3"]);
  assert.ok(summary.textContent.includes("S9 no existe."), "unknown ids stay as text");
});

test("claim, intervention and objection references link consistently across the result and folded record", () => {
  const record: CourtEvent[] = [
    events[0]!,
    { type: "instruction_opened" },
    { type: "evidence_filed", evidence: { id: "P1", by: "grok", claimId: "A2", title: "Prueba", url: "https://example.org", excerpt: "Dato." } },
    { type: "instruction_completed", by: "grok", searches: [{ claimId: "A2", supporting: "Sobre [A2] y I1.", opposing: "Sobre O1." }] },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "[A2] remite a I2 y O1; A99 es desconocida.", evidenceIds: [] },
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "[A2] no prueba I2." },
    { type: "objection_reply", objectionId: "O1", by: "grok", text: "I1 se refiere a [A2]." },
    { type: "ruling", objectionId: "O1", sustained: false, reason: "I2 respalda [A2]." },
    { type: "statement", id: "I2", by: "claude", stage: "rebuttal", text: "Respuesta a O1 sobre A2.", evidenceIds: [] },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "[A2] y O1 apoyan I1." },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "I2 responde a O1 sobre [A2]." },
    { type: "case_summary", text: "[A2] se debatió en I1 e I2 y en O1. URL: https://example.org/A2/I1." },
  ];
  const recorded = record.map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const view = project(recorded);
  const html = renderToStaticMarkup(createElement("main", null,
    createElement(CaseResult, { c, view, events: recorded }),
    createElement(Case, { events: recorded, view, caseId: c.id }),
  ));
  const { document } = parseHTML(html);
  for (const id of ["A1", "A2", "I1", "I2", "O1"]) {
    assert.equal(document.querySelectorAll(`[id="${id}"]`).length, 1, id + " has one target");
    assert.ok(document.querySelector(`a[href="#${id}"]`), id + " is linked");
  }
  for (const id of ["I1", "I2", "O1"]) {
    const target = document.getElementById(id)!;
    assert.ok(target.closest("[data-case]"));
    assert.ok(target.closest("details"), "the target is inside a fold");
    assert.ok(target.querySelector(`a[href="#${id}"]`), "the entry has its own permalink");
  }
  const statement = document.getElementById("I1")!;
  assert.ok(statement.textContent.includes("[A2] remite a I2 y O1; A99 es desconocida."));
  assert.deepEqual([...statement.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#I1", "#A2", "#I2", "#O1"]);
  assert.equal(statement.querySelector("a[href=\"#A2\"]")?.textContent, "A2");
  assert.ok(!document.querySelector('a[href="#A99"]'));
  const summary = document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.deepEqual([...summary.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#A2", "#I1", "#I2", "#O1"]);
  assert.ok(summary.textContent.includes("https://example.org/A2/I1."), "case-like IDs in URLs remain untouched");
  const vote = document.getElementById("voto-A1-grok")!;
  assert.deepEqual([...vote.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#A2", "#O1", "#I1"]);
  const moderator = document.querySelector("#fundamentos-A1 li.border-l-2")!;
  assert.deepEqual([...moderator.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#I2", "#O1", "#A2"]);
  const caseRecord = document.querySelector("[data-case]")!;
  assert.ok(caseRecord.querySelectorAll('a[href="#A2"]').length >= 6, "claim references are linked throughout the record");
  assert.ok(caseRecord.querySelectorAll('a[href="#O1"]').length >= 4, "the reply and ruling identify their objection");
});

test("the displayed historical summary links rewritten source references", () => {
  const record: CourtEvent[] = [
    events[0]!,
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "case_summary", text: "El resumen se apoya en S1." },
  ];
  const recorded = record.map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { events: displayed } = displayHistoricalCitations(recorded);
  const html = renderToStaticMarkup(createElement(CaseResult, { c, view: project(displayed), events: displayed }));
  assert.ok(html.includes('href="#E1"'));
  assert.ok(!html.includes('href="#S1"'));
});

test("each quoted claim shows its conclusion, linked to the claim's reasons", () => {
  const { document } = parseHTML(render(events));
  const quote = document.querySelector("blockquote")!;
  for (const [id, verdict, label] of [["A1", "falso", "Falso"], ["A2", "insostenible", "Insostenible"]]) {
    const links = quote.querySelectorAll('a[href="#fundamentos-' + id + '"]');
    assert.equal(links.length, 1, id);
    assert.ok(links[0].querySelector(".bg-" + verdict), id + " shows the conclusion, not the votes");
    assert.ok(!links[0].querySelector(".size-6"), id + " has no vote chips");
    assert.match(links[0].getAttribute("aria-label") ?? "", new RegExp("Afirmación " + id + ": " + label));
    const target = document.getElementById("fundamentos-" + id)!;
    assert.equal(target.tagName, "DETAILS");
    assert.equal(target.closest("article")?.id, id);
  }
  assert.ok(quote.querySelector('a[href="#fundamentos-A2"] svg.text-seal'), "a tiebreak shows the gavel");
  assert.ok(!quote.querySelector('a[href="#fundamentos-A1"] svg.text-seal'));
});

test("partial quotes are underlined in their conclusion's color, while a quote of the whole content only gets its mark", () => {
  const { document } = parseHTML(render(events));
  assert.deepEqual([...document.querySelectorAll("blockquote mark.cita")].map((m) => m.getAttribute("data-verdict")), ["falso", "no_verificable"]);
  const whole: CaseRecord = { ...c, submission: { kind: "text", text: "Única afirmación." } };
  const single = parseHTML(render([
    { type: "claims_entered", claims: [{ id: "A1", quote: "Única afirmación", text: "Única afirmación examinada" }] },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
  ], whole)).document;
  const quote = single.querySelector("blockquote")!;
  assert.ok(!quote.querySelector("mark"));
  assert.ok(quote.textContent.includes("Única afirmación"));
  assert.ok(quote.querySelector('a[href="#fundamentos-A1"]'));
});

test("the conclusion's tooltip links each compact vote to that analyst's own reason, while an absence is not a link", () => {
  const { document } = parseHTML(render(events));
  const quote = document.querySelector("blockquote")!;
  assert.ok(quote.querySelector('[role="group"][aria-label="Votos de los analistas sobre A1"] a[href="#voto-A1-grok"]'));
  for (const by of COUNSEL) {
    const link = quote.querySelector('a[href="#voto-A1-' + by + '"]');
    const target = document.getElementById("voto-A1-" + by);
    assert.ok(link && target, by);
    assert.ok(link.querySelector(".size-6"), "compact vote uses the small chip");
    assert.ok(target.textContent.includes("Fundamento de " + by));
    assert.equal(target.closest("details")?.querySelector("summary")?.textContent, "Fundamentos de cada voto sobre " + target.closest("article")?.id);
    assert.match(link.getAttribute("aria-label") ?? "", /Ver fundamento/);
  }
  assert.ok(quote.querySelector('a[href="#voto-A2-gemini"]'));
  assert.ok(!quote.querySelector('a[href="#voto-A2-grok"]'));
  assert.ok(quote.querySelector('[aria-label="Grok: no votó"]'));
  assert.ok(document.querySelector('article .size-10'), "claim cards keep their larger chips");
});

test("historical and dismissed cases do not invent a summary; link and image submissions remain readable", () => {
  const old = events.filter((e) => e.type !== "case_summary");
  assert.ok(!render(old).includes("Resumen del caso"));
  const dismissed = render([{ type: "dismissed", reason: "No hay afirmaciones verificables." }]);
  assert.ok(dismissed.includes("No hay afirmaciones verificables."));
  assert.ok(!dismissed.includes("Resumen del caso"));
  assert.ok(render(events, { ...c, submission: { kind: "link", url: "https://example.org", note: "Comentario" } }).includes("https://example.org"));
  assert.ok(render(events, { ...c, submission: { kind: "image", mimeType: "image/png" } }).includes('/c/fixture/image'));
});

test("the result shows all four verdicts and preserves historical Insostenible decisions", () => {
  const mixed = events.map((e): CourtEvent => e.type === "vote" && e.claimId === "A2" ? { ...e, verdict: "enganoso" } : e);
  const { document } = parseHTML(render(mixed));
  for (const [label, color] of [["Verdadero", "verdadero"], ["Falso", "falso"], ["Insostenible", "insostenible"], ["Engañoso", "enganoso"]]) {
    const swatches = [...document.querySelectorAll(".bg-" + color)];
    assert.ok(swatches.some((swatch) => swatch.parentElement?.textContent.includes(label)), label);
  }
  const card = document.getElementById("A2")!;
  assert.ok(card.querySelector(".text-insostenible-text")?.textContent.includes("Insostenible"));
  assert.ok(card.querySelector(".text-enganoso-text")?.textContent.includes("Engañoso"));
  assert.ok(card.querySelector('[aria-label="Gemini: Engañoso"] .bg-enganoso'));
  assert.ok(card.querySelector('[aria-label="Desempate del moderador: Insostenible"] .bg-insostenible'));
  assert.ok(!document.toString().includes("No verificable"));
});

test("the seal carries the recorded moderator's mark without repeating their name in the reason", () => {
  const { document } = parseHTML(render(events));
  const card = document.getElementById("A2")!;
  const reason = [...card.querySelectorAll("li")].find((li) => li.textContent.startsWith("Moderador"))!;
  assert.match(reason.textContent, /^Moderador:/);
  assert.ok(card.querySelector('[aria-label^="Desempate del moderador"] svg line'), "the seal carries the Claude mark");
});

test("vote chips show the model id and effort the case recorded for each seat", () => {
  const { document } = parseHTML(render(events));
  const card = document.getElementById("A1")!;
  assert.ok(card.querySelector('[title="ChatGPT (gpt-6.1-sol high): Falso"]'));
  assert.ok(card.querySelector('[title="Gemini: Falso"]'), "seats without a recorded model keep the plain label");
});

test("older cases use the opening event for vote details without repeating the moderator", () => {
  const opened: CourtEvent = { type: "session_opened", judgeModel: "google/gemini-4-argon", judgeEffort: "high", counselModels: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" }, counselEfforts: { grok: "high", gemini: "high", claude: null, chatgpt: "high" } };
  const old: CaseRecord = { ...c, models: undefined };
  const recorded = [opened, ...events].map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(CaseResult, { c: old, view: project(recorded), events: recorded })));
  assert.equal(document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent, "Por el moderador");
  assert.ok(document.querySelector('[title="Claude (claude-opus-5.5): Falso"]'), "no effort when none was configured");
  assert.match(parseHTML(render(events, old)).document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent ?? "", /^Por el moderador$/);
});

test("a Quick check shows the content verdict and four votes with reasons collapsed, and no claims card", () => {
  const quick: CaseRecord = { ...c, submission: { kind: "text", text: "Una afirmación.", check: "quick" } };
  const input: CourtEvent[] = [
  { type: "session_opened", judgeModel: "anthropic/claude-opus-5.5", counselModels: { grok: "g", gemini: "m", claude: "c", chatgpt: "o" } },
  ...COUNSEL.map((by): CourtEvent => ({ type: "quick_response", by, text: "Respuesta de " + by + ".\nSegunda línea.", sources: by === "grok" ? [{ url: "https://example.test/indec", title: "INDEC" }] : [] })),
  ...COUNSEL.map((by, i): CourtEvent => ({ type: "content_vote", by, verdict: i === 0 ? "verdadero" : "falso", rationale: "Voto de " + by })),
  { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "" },
  { type: "session_closed" },
];
  const { document } = parseHTML(render(input, quick));
  assert.match(document.querySelector('[aria-label="Resultado del contenido completo: Falso"]')!.textContent, /Falso/);
  const figure = document.querySelector("figure")!;
  assert.ok(figure.querySelector("figcaption")?.textContent?.startsWith("Chequeo Rápido"));
  const votes = figure.querySelector("details")!;
  assert.equal(votes.querySelector("summary")?.textContent, "Fundamentos de cada voto");
  assert.ok(!votes.hasAttribute("open"));
  assert.equal(votes.querySelectorAll("li").length, 4);
  const chips = figure.querySelector('[role="group"][aria-label="Votos de los analistas sobre el contenido"]')!;
  assert.ok(chips.className.includes("justify-end"));
  assert.equal(chips, figure.lastElementChild);
  for (const [i, by] of COUNSEL.entries()) {
    const link = chips.querySelector('a[href="#voto-contenido-' + by + '"]')!;
    assert.ok(link.querySelector(".size-10 svg"), by + " has a model mark");
    assert.ok(link.querySelector(".bg-" + (i === 0 ? "verdadero" : "falso")), by + " has a verdict");
    assert.equal(document.getElementById("voto-contenido-" + by)?.closest("details"), votes);
  }
  assert.ok(chips.querySelector('[title="ChatGPT (gpt-6.1-sol high): Falso"]'));
  assert.equal(document.querySelector("#case-claims-title"), null);
  assert.match(document.toString(), /Chequeo rápido/);
});

test("a Quick majority summary is visible without expanding the individual votes", () => {
  const quick: CaseRecord = { ...c, submission: { kind: "text", text: "Una afirmación.", check: "quick" } };
  const input: CourtEvent[] = [
    ...COUNSEL.map((by): CourtEvent => ({ type: "content_vote", by, verdict: "falso", rationale: "Fundamento individual de " + by })),
    { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "case_summary", text: "La mayoría encontró que los datos contradicen la afirmación." },
    { type: "session_closed" },
  ];
  const { document } = parseHTML(render(input, quick));
  const summary = document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.match(summary.textContent, /Por el moderador/);
  assert.match(summary.textContent, /La mayoría encontró que los datos contradicen la afirmación/);
  assert.ok(!document.querySelector("figure details")!.hasAttribute("open"));
});

test("a Quick tie displays the recorded moderator reasoning as the summary", () => {
  const quick: CaseRecord = { ...c, submission: { kind: "text", text: "Una afirmación.", check: "quick" } };
  const input: CourtEvent[] = [
    ...COUNSEL.map((by, i): CourtEvent => ({ type: "content_vote", by, verdict: i < 2 ? "falso" : "enganoso", rationale: "Voto de " + by })),
    { type: "content_judgment", verdict: "enganoso", method: "judge", reasoning: "El contexto cambia el sentido." },
    { type: "session_closed" },
  ];
  const { document } = parseHTML(render(input, quick));
  const summary = document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.equal(document.querySelector("[data-case-overview]")?.nextElementSibling, summary);
  assert.match(summary.textContent, /Por el moderador/);
  assert.match(summary.textContent, /El contexto cambia el sentido\./);
  assert.ok(!document.querySelector("figure details")!.hasAttribute("open"));
});

test("Quick summaries distinguish majority results from claim and content tie-breaks", () => {
  const quick: CaseRecord = { ...c, submission: { ...c.submission, check: "quick", identifyClaims: true } };
  const input: CourtEvent[] = [
    ...events.filter((e) => e.type !== "case_summary"),
    { type: "content_judgment", verdict: "enganoso", method: "judge", reasoning: "El contenido pierde contexto." },
    { type: "case_summary", text: "La mayoría decidió que A1 es falsa." },
  ];
  const { document } = parseHTML(render(input, quick));
  const summary = document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.match(summary.textContent, /La mayoría decidió que A1 es falsa/);
  assert.match(summary.textContent, /Afirmación A2: El expediente es insuficiente/);
  assert.match(summary.textContent, /Contenido completo: El contenido pierde contexto/);
  assert.doesNotMatch(summary.textContent, /Afirmación A1:/);

  const allTies = input.filter((e) => e.type !== "case_summary");
  const tieSummary = parseHTML(render(allTies, quick)).document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.match(tieSummary.textContent, /Afirmación A2: El expediente es insuficiente/);
  assert.match(tieSummary.textContent, /Contenido completo: El contenido pierde contexto/);
});

test("a resolved historical Quick case without recorded moderator text says so", () => {
  const quick: CaseRecord = { ...c, submission: { kind: "text", text: "Una afirmación.", check: "quick" } };
  const input: CourtEvent[] = [
    { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "session_closed" },
  ];
  const { document } = parseHTML(render(input, quick));
  const summary = document.querySelector('[aria-labelledby="case-summary-title"]')!;
  assert.match(summary.textContent, /No hay resumen del moderador registrado/);
  assert.doesNotMatch(summary.textContent, /Por el moderador/);
  assert.ok(!parseHTML(render([{ type: "dismissed", reason: "Sin afirmaciones." }], quick)).document.querySelector('[aria-labelledby="case-summary-title"]'));
});

test("quick content chips distinguish absent votes from recorded no corresponde votes", () => {
  const input: CourtEvent[] = [
    { type: "content_vote", by: "grok", verdict: null, rationale: "No corresponde." },
    { type: "content_vote", by: "gemini", verdict: "enganoso", rationale: "Falta contexto." },
  ];
  for (const submission of [
    { kind: "text" as const, text: "Contenido", check: "quick" as const },
    { kind: "link" as const, url: "https://example.org", check: "quick" as const },
    { kind: "image" as const, mimeType: "image/png", check: "quick" as const },
  ]) {
    const { document } = parseHTML(render(input, { ...c, submission, models: undefined }));
    assert.equal(document.querySelector("figure figcaption")?.textContent, "Chequeo Rápido");
    const chips = document.querySelector('[aria-label="Votos de los analistas sobre el contenido"]')!;
    assert.ok(chips.querySelector('a[href="#voto-contenido-grok"][aria-label="Ver fundamento de Grok: No corresponde"] [aria-label="Grok: No corresponde"]'));
    assert.ok(chips.querySelector('a[href="#voto-contenido-gemini"] [aria-label="Gemini: Engañoso"]'));
    assert.ok(chips.querySelector('[aria-label="Claude: no votó"]'));
    assert.ok(!chips.querySelector('a[href="#voto-contenido-claude"]'));
  }
  const empty = parseHTML(render([], { ...c, submission: { kind: "text", text: "Contenido", check: "quick" }, models: undefined })).document;
  assert.equal(empty.querySelectorAll('[aria-label="Votos de los analistas sobre el contenido"] [title$="no votó"]').length, 4);
  assert.equal(empty.querySelector("figure details"), null);
});
