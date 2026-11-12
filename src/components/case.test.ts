import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { displayHistoricalCitations } from "../domain/historical-citations.ts";
import { Case } from "./case.tsx";

function render(events: CourtEvent[]) {
  const recorded: RecordedEvent[] = events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-10-30T14:00:00.000Z" }));
  return renderToStaticMarkup(createElement(Case, { events: recorded, view: project(recorded), caseId: "fixture" }));
}

test("the case record keeps collection progress in a Fuentes section", () => {
  const document = parseHTML(render([{ type: "instruction_opened" }, { type: "source_collection_started", total: 1, batches: 1 }, { type: "source_batch_completed", batch: 1, batches: 1, count: 1, completed: 1, total: 1, failed: 0 }, { type: "evidence_unified", sources: [] }])).document;
  const section = [...document.querySelectorAll("details")].find((item) => item.querySelector("summary h3")?.textContent === "Fuentes")!;
  assert.match(section.textContent, /Enlaces consultados · 1 de 1/);
  assert.ok(section.textContent.includes("El moderador consultó 1 enlace (1 de 1; lote 1 de 1)"));
  assert.ok([...document.querySelectorAll("summary h3")].some((item) => item.textContent === "Crítica de fuentes"));
});

test("the case record retains batch URLs in the Fuentes section", () => {
  const url = "https://example.test/source";
  const document = parseHTML(render([{ type: "instruction_opened" }, { type: "source_collection_started", total: 1, batches: 1 }, { type: "source_batch_started", batch: 1, batches: 1, urls: [url] }, { type: "source_batch_completed", batch: 1, batches: 1, count: 1, completed: 1, total: 1, failed: 1, sources: [{ url, failed: true }] }, { type: "evidence_unified", sources: [] }])).document;
  const section = [...document.querySelectorAll("details")].find((item) => item.querySelector("summary h3")?.textContent === "Fuentes")!;
  assert.equal(section.querySelectorAll(`a[href="${url}"]`).length, 2);
  assert.match(section.textContent, /source · No se pudo leer/);
});

test("majority results show small vote chips with agreeing analysts first and dissent last", () => {
  const input: CourtEvent[] = [
    { type: "claims_entered", claims: ["A1", "A2", "A3", "A4", "A5"].map((id) => ({ id, quote: id, text: id })) },
    ...COUNSEL.map((by, i): CourtEvent => ({ type: "vote", by, claimId: "A1", verdict: i === 0 ? "verdadero" : "falso", rationale: "A1 " + by })),
    ...COUNSEL.map((by): CourtEvent => ({ type: "vote", by, claimId: "A2", verdict: "verdadero", rationale: "A2 " + by })),
    ...COUNSEL.slice(0, 3).map((by): CourtEvent => ({ type: "vote", by, claimId: "A3", verdict: "falso", rationale: "A3 " + by })),
    ...COUNSEL.map((by, i): CourtEvent => ({ type: "vote", by, claimId: "A5", verdict: i % 2 === 0 ? "verdadero" : "falso", rationale: "A5 " + by })),
    { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A2", verdict: "verdadero", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A3", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A4", verdict: "verdadero", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A5", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A1", verdict: "verdadero", method: "judge", reasoning: "Razón del moderador." },
  ];
  const { document } = parseHTML(render(input));
  const result = [...document.querySelectorAll("details")].find((d) => d.querySelector("summary h3")?.textContent === "Resultado")!;
  const groups = result.querySelectorAll('[role="group"]');
  assert.equal(groups.length, 4);
  const labels = (group: Element) => [...group.children].map((el) => el.querySelector("[title]")?.getAttribute("title") ?? el.getAttribute("title"));
  assert.deepEqual(labels(groups[0]), ["Gemini: Falso", "Claude: Falso", "ChatGPT: Falso", "Grok: Verdadero"]);
  assert.deepEqual(labels(groups[1]), ["Grok: Verdadero", "Gemini: Verdadero", "Claude: Verdadero", "ChatGPT: Verdadero"]);
  assert.deepEqual(labels(groups[2]), ["Grok: Falso", "Gemini: Falso", "Claude: Falso", "ChatGPT: no votó"]);
  assert.deepEqual(labels(groups[3]), ["Gemini: Falso", "ChatGPT: Falso", "Grok: Verdadero", "Claude: Verdadero"], "inconsistent records still place all dissenting votes last");
  assert.deepEqual([...groups[0].querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#voto-A1-gemini", "#voto-A1-claude", "#voto-A1-chatgpt", "#voto-A1-grok"]);
  assert.equal(groups[2].querySelectorAll("a").length, 3, "an absent vote has no reason to link to");
  assert.equal(groups[0].querySelectorAll(".size-6").length, 4, "the chips use the compact size");
  assert.ok(!groups[0].parentElement!.textContent.includes("por mayoría"));
  assert.ok(result.textContent.includes("Resultado de A4: Verdadero, por mayoría."), "a record without votes retains the decision method");
  assert.ok(result.textContent.includes("Desempate del moderador sobre A1: Verdadero. Razón del moderador."));
});

test("the case record labels translated contributions and retains their originals in both stages", () => {
  const evidence = { id: "P1", by: "grok" as const, claimId: "A1", title: "Informe oficial", url: "https://example.org/report", excerpt: "El investigado no entregó los documentos.", stance: "opposes" as const, translation: { language: "es", original: { title: "Relatório oficial", excerpt: "O investigado não entregou os documentos." } } };
  const html = render([
    { type: "instruction_opened" },
    { type: "evidence_filed", evidence },
    { type: "evidence_unified", sources: [{ id: "E1", title: evidence.title, url: evidence.url, contributions: [evidence] }] },
  ]);
  const { document } = parseHTML(html);
  for (const id of ["P1", "E1"]) {
    const card = document.getElementById(id)!;
    assert.ok(card.textContent.includes(evidence.excerpt));
    assert.ok(card.textContent.includes(evidence.translation.original.excerpt));
    assert.ok(card.textContent.includes("Traducción automática"));
  }
});

test("the case record displays shared attribution, bilateral searches, all reliability votes and the exclusion warning", () => {
  const url = "https://example.org/report";
  const html = render([
    { type: "instruction_opened" },
    { type: "instruction_completed", by: "grok", searches: [{ claimId: "A1", supporting: "Busqué tablas oficiales a favor.", opposing: "Busqué documentos en contra, sin resultados." }] },
    { type: "evidence_unified", sources: [{ id: "S1", url, title: "Informe compartido", contributions: [
      { id: "P1", by: "grok", claimId: "A1", title: "Informe compartido", url, excerpt: "Cifras que respaldan la afirmación.", stance: "supports" },
      { id: "P2", by: "gemini", claimId: "A1", title: "Informe compartido", url, excerpt: "Datos que contradicen la afirmación.", stance: "opposes" },
    ] }] },
    ...COUNSEL.map((by, i): CourtEvent => ({ type: "source_review_vote", by, sourceId: "S1", veto: i < 3, reason: i < 3 ? "No identifica autores ni métodos verificables." : "La fuente permite consultar los documentos originales." })),
    { type: "source_decided", sourceId: "S1", excluded: true },
    { type: "instruction_closed" },
    { type: "statement", id: "I1", by: "claude", stage: "opening", text: "Sin pruebas admitidas, no puedo verificar la afirmación.", evidenceIds: [] },
  ]);
  for (const text of ["Instrucción", "Busqué tablas oficiales a favor.", "Busqué documentos en contra, sin resultados.", 'id="S1"', "Aportada por Grok, Gemini", "a favor", "en contra", "3/4 votos por anular", "Anulada", "No identifica autores ni métodos verificables.", "La fuente permite consultar los documentos originales.", "No puede usarse como prueba", "Termina la instrucción"]) {
    assert.ok(html.includes(text), "Missing case content: " + text);
  }
  assert.ok(html.indexOf("Termina la instrucción") < html.indexOf('id="I1"'));
});

test("source cards show each reliability vote and decision once, without repeated case entries", () => {
  const events: CourtEvent[] = [
    { type: "evidence_unified", sources: [
      { id: "S1", url: "https://example.org/1", title: "Fuente anulada", contributions: [] },
      { id: "S2", url: "https://example.org/2", title: "Fuente admitida", contributions: [] },
    ] },
    ...["S1", "S2"].flatMap((sourceId) => COUNSEL.map((by, i): CourtEvent => ({
      type: "source_review_vote", by, sourceId, veto: sourceId === "S1" && i < 3, reason: "Fundamento único " + sourceId.toLowerCase() + " " + by,
    }))),
    { type: "source_decided", sourceId: "S1", excluded: true },
    { type: "source_decided", sourceId: "S2", excluded: false },
    { type: "instruction_closed" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "Voto sobre la afirmación." },
  ];
  const html = render(events);
  const { document } = parseHTML(html);
  for (const sourceId of ["S1", "S2"]) {
    const card = document.getElementById(sourceId)!;
    assert.ok([...card.querySelectorAll("summary")].some((s) => s.textContent.includes("Votos y fundamentos sobre la confiabilidad")));
    for (const by of COUNSEL) {
      const reason = "Fundamento único " + sourceId.toLowerCase() + " " + by;
      assert.equal(html.split(reason).length - 1, 1, reason);
      assert.ok(card.textContent.includes(reason));
    }
  }
  assert.ok(document.getElementById("S1")!.textContent.includes("Anulada"));
  assert.ok(document.getElementById("S2")!.textContent.includes("Admitida"));
  assert.ok(!html.includes("anulada por mayoría (al menos 3 de 4 votos)"));
  assert.ok(!html.includes("admitida; no hubo mayoría para anularla"));
  assert.equal(document.querySelectorAll("[data-case] ol > li").length, 3, "no empty list entries for the suppressed events");
  assert.ok(html.includes("Voto sobre la afirmación."), "claim votes remain in the case record");
});

test("source events without a matching card or with an earlier different vote remain visible", () => {
  const html = render([
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "source_review_vote", by: "grok", sourceId: "S1", veto: true, reason: "Primera opinión sobre la fuente." },
    { type: "source_review_vote", by: "grok", sourceId: "S1", veto: false, reason: "Opinión final sobre la fuente." },
    { type: "source_review_vote", by: "gemini", sourceId: "S99", veto: false, reason: "Voto sin tarjeta correspondiente." },
    { type: "source_decided", sourceId: "S99", excluded: false },
  ]);
  for (const reason of ["Primera opinión sobre la fuente.", "Opinión final sobre la fuente.", "Voto sin tarjeta correspondiente."]) {
    assert.equal(html.split(reason).length - 1, 1);
  }
  assert.ok(html.includes("admitida; no hubo mayoría para anularla."));
});

test("historical evidence without instruction or stance remains visible and keeps its original citation anchor", () => {
  const html = render([
    { type: "evidence_filed", evidence: { id: "P1", by: "claude", claimId: "A1", title: "Documento histórico", url: "https://example.org/old", excerpt: "Datos citados en una sesión anterior." } },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Mi evaluación se basa en los datos registrados.", evidenceIds: ["P1"] },
    { type: "session_closed" },
  ]);
  assert.ok(html.includes('id="P1"'));
  assert.ok(html.includes('href="#P1"'));
  assert.ok(html.includes("Documento histórico"));
  assert.ok(!html.includes("Anulada"));
});

test("historical unified citations display E and retain old inbound anchors", () => {
  const original: CourtEvent[] = [
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/old", title: "Fuente histórica", contributions: [] }] },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "La fuente S1 respalda mi evaluación.", evidenceIds: ["S1"] },
  ];
  const recorded = original.map((e, i) => ({ ...e, seq: i + 1, at: "2026-10-30T14:00:00.000Z" }));
  const { events, aliases } = displayHistoricalCitations(recorded);
  const html = renderToStaticMarkup(createElement(Case, { events, view: project(events), caseId: "fixture", sourceAliases: aliases }));
  assert.ok(html.includes('id="E1"'));
  assert.ok(html.includes('id="S1"'));
  assert.ok(html.includes('href="#E1"'));
  assert.ok(html.includes("La fuente "));
  assert.ok(!html.includes('href="#S1"'));
});

test("citations mentioned in an intervention link inline, and only the unmentioned ones remain listed", () => {
  const html = render([
    { type: "evidence_unified", sources: ["E1", "E2", "E10"].map((id) => ({ id, url: "https://example.org/" + id, title: "Fuente " + id, contributions: [] })) },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "La salida está probada (E1, E10). Sin orden de prisión, A1 no se sostiene.", evidenceIds: ["E1", "E10", "E2"] },
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "E10 no dice lo que I1 le atribuye." },
  ]);
  const { document } = parseHTML(html);
  const statement = document.getElementById("I1")!;
  const text = statement.querySelectorAll("p")[1]!;
  assert.deepEqual([...text.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#E1", "#E10"]);
  assert.ok(text.textContent.includes("(E1, E10)"), "the text reads unchanged around its links");
  assert.ok(!text.innerHTML.includes('href="#A1"'), "unknown claims remain plain text");
  const rest = [...statement.querySelectorAll("p")].at(-1)!;
  assert.ok(rest.textContent.startsWith("También cita"));
  assert.deepEqual([...rest.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#E2"]);
  assert.ok(!html.includes("Cita:"));
  const objection = document.getElementById("O1")!;
  assert.deepEqual([...objection.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#O1", "#I1", "#E10", "#I1"]);
});

test("the case record folds into stages, each analyst's instruction run up to its close, and debate turns", () => {
  const evidence = (id: string, by: "grok" | "gemini"): CourtEvent => ({ type: "evidence_filed", evidence: { id, by, claimId: "A1", title: "Doc " + id, url: "https://example.org/" + id, excerpt: "Dato concreto de " + id + ".", stance: "supports" } });
  const html = render([
    { type: "claims_entered", claims: [{ id: "A1", quote: "", text: "Afirmación." }] },
    { type: "instruction_opened" },
    evidence("P1", "grok"), evidence("P2", "grok"),
    { type: "instruction_completed", by: "grok", searches: [{ claimId: "A1", supporting: "a favor", opposing: "en contra" }] },
    evidence("P3", "gemini"),
    { type: "instruction_completed", by: "gemini", searches: [] },
    { type: "evidence_unified", sources: [] },
    { type: "instruction_closed" },
    { type: "floor_granted", to: "grok", stage: "opening" },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Mi exposición sobre la afirmación.", evidenceIds: [] },
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "Sin respaldo." },
    { type: "objection_reply", by: "grok", objectionId: "O1", text: "Lo tiene." },
    { type: "ruling", objectionId: "O1", sustained: false, reason: "Tiene respaldo." },
    { type: "floor_granted", to: "gemini", stage: "closing" },
    { type: "statement", id: "I2", by: "gemini", stage: "closing", text: "Mi conclusión sobre la afirmación.", evidenceIds: [] },
    { type: "vote", by: "gemini", claimId: "A1", verdict: "verdadero", rationale: "Probada." },
    { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "También probada." },
    { type: "judgment", claimId: "A1", verdict: "verdadero", method: "consensus", reasoning: "" },
    { type: "session_closed" },
  ]);
  const { document } = parseHTML(html);
  const stages = [...document.querySelectorAll("[data-fold-scope=section] > details")];
  assert.deepEqual(stages.map((d) => d.querySelector("h3")!.textContent), ["Apertura", "Instrucción", "Crítica de fuentes", "Exposiciones iniciales", "Conclusiones y votos", "Resultado"]);
  assert.ok(stages.every((d) => !d.hasAttribute("open")), "stages start collapsed");
  assert.equal(document.querySelectorAll("[data-case] button[aria-label^='Expandir todo']").length, stages.length + 1, "one pair of controls per stage and one for the case record");

  const runs = [...stages[1]!.querySelectorAll("details.fold")];
  assert.equal(runs.length, 2, "one run per analyst");
  assert.ok(runs[0]!.querySelector("summary")!.textContent.includes("Grok · aportes de pruebas · 2 pruebas"));
  assert.ok(runs[0]!.querySelector("#P1") && runs[0]!.querySelector("#P2") && !runs[0]!.querySelector("#P3"));
  assert.ok(runs[0]!.textContent.includes("Grok cierra sus aportes"), "the run ends with its close");
  assert.ok(runs[1]!.querySelector("#P3") && runs[1]!.textContent.includes("Gemini cierra sus aportes"));

  const turn = stages[3]!.querySelector("details.fold")!;
  assert.ok(turn.querySelector("summary")!.textContent.includes("Grok · exposición inicial · I1"));
  assert.ok(turn.querySelector("#I1") && turn.querySelector("#O1") && turn.textContent.includes("Lo tiene.") && turn.textContent.includes("Objeción rechazada"));
  const closing = stages[4]!;
  const closingTurn = closing.querySelector("details.fold")!;
  assert.ok(closingTurn.textContent.includes("Probada."), "the speaker's vote stays in their turn");
  assert.ok(!closingTurn.textContent.includes("También probada."), "another analyst's vote does not");
  assert.ok(closing.textContent.includes("También probada."));
});

test("the stored simulation flag labels the case record independently of the current AI mode", () => {
  const html = render([{ type: "session_opened", simulated: true, judgeModel: "fixture", counselModels: { grok: "fixture", gemini: "fixture", claude: "fixture", chatgpt: "fixture" } }]);
  assert.ok(html.includes("Simulación local"));
  assert.ok(html.includes("fuentes y respuestas ficticias"));
  assert.ok(!html.includes("modera fixture"), "the moderator is introduced by the panel instead");
});

test("the case record links OKF page citations to the case evidence route", () => {
  const html = render([
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "La evidencia disponible permite contrastar la afirmación.", evidenceIds: ["/evidence/grok/passage.md#p3"] },
  ]);
  assert.ok(html.includes('href="/c/fixture/evidence/grok/passage.md#p3"'));
});

test("the case record omits the moderator's summary because it is already shown in the case result", () => {
  const html = render([{ type: "case_summary", text: "El debate trató las diferencias entre los analistas." }, { type: "session_closed" }]);
  assert.ok(!html.includes("Resumen del moderador"));
  assert.ok(!html.includes("El debate trató las diferencias entre los analistas."));
  assert.ok(html.includes("Termina el debate"));
});

test("the case record renders historical Insostenible and new Engañoso verdicts", () => {
  const html = render([
    { type: "vote", by: "grok", claimId: "A1", verdict: "no_verificable", rationale: "Faltan pruebas." },
    { type: "judgment", claimId: "A1", verdict: "enganoso", method: "consensus", reasoning: "" },
  ]);
  assert.match(html, /text-insostenible-text[^>]*>Insostenible/);
  assert.match(html, /text-enganoso-text[^>]*>Engañoso/);
  assert.ok(!html.includes("No verificable"));
});

test("the case record records content votes, abstentions and the moderator's tiebreak", () => {
  const html = render([
    { type: "content_vote", by: "grok", verdict: "enganoso", rationale: "La narrativa omite contexto." },
    { type: "content_vote", by: "gemini", verdict: null, rationale: "Son afirmaciones independientes." },
    { type: "content_judgment", verdict: "enganoso", method: "judge", reasoning: "El contexto cambia el sentido del conjunto." },
  ]);
  assert.ok(html.includes("sobre el contenido completo"));
  assert.ok(html.includes("considera que no corresponde un voto"));
  assert.ok(html.includes("Resultado del contenido completo"));
  assert.ok(html.includes("Desempate del moderador"));
  assert.ok(html.includes("El contexto cambia el sentido del conjunto."));
});

test("a Quick check lists each analyst's answer with its cited pages, then the votes and the result", () => {
  const input: CourtEvent[] = [
  { type: "session_opened", judgeModel: "anthropic/claude-opus-5.5", counselModels: { grok: "g", gemini: "m", claude: "c", chatgpt: "o" } },
  ...COUNSEL.map((by): CourtEvent => ({ type: "quick_response", by, text: "Respuesta de " + by + ".\nSegunda línea.", sources: by === "grok" ? [{ url: "https://example.test/indec", title: "INDEC" }] : [] })),
  ...COUNSEL.map((by, i): CourtEvent => ({ type: "content_vote", by, verdict: i === 0 ? "verdadero" : "falso", rationale: "Voto de " + by })),
  { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "" },
  { type: "session_closed" },
];
  const { document } = parseHTML(render(input));
  const titles = [...document.querySelectorAll("summary h3")].map((h) => h.textContent);
  assert.deepEqual(titles, ["Apertura", "Respuestas", "Resultado"]);
  const answers = [...document.querySelectorAll('[id^="respuesta-"]')];
  assert.deepEqual(answers.map((a) => a.id), COUNSEL.map((by) => "respuesta-" + by));
  assert.match(answers[0]!.textContent, /Respuesta de grok\.\nSegunda línea\./);
  assert.equal(answers[0]!.querySelector("a")?.getAttribute("href"), "https://example.test/indec");
  assert.match(document.toString(), /1 fuente citada/);
  assert.match(document.toString(), /4 votos sobre el contenido completo/);
  assert.match(document.toString(), /Empieza el chequeo ·/);
  assert.doesNotMatch(document.toString(), /afirmaciones a examinar|Empieza el debate/);
});

test("questions list the classification and the answers, an absent answer, and no votes, while the result card holds the syntheses", () => {
  const input: CourtEvent[] = [
    { type: "session_opened", judgeModel: "anthropic/claude-opus-5.5", counselModels: { grok: "g", gemini: "m", claude: "c", chatgpt: "o" } },
    { type: "content_classified", kind: "question", items: [{ id: "P1", quote: "", text: "¿Cuántos habitantes tiene la Argentina?" }] },
    ...COUNSEL.slice(0, 3).map((by): CourtEvent => ({ type: "quick_response", by, text: "Respuesta de " + by, sources: [] })),
    { type: "absence", by: "chatgpt", stage: "answer" },
    { type: "answer_synthesis", questionId: "P1", text: "Síntesis que no se repite en el registro.", majority: true },
    { type: "session_closed" },
  ];
  const { document } = parseHTML(render(input));
  const html = document.toString();
  assert.deepEqual([...document.querySelectorAll("summary h3")].map((h) => h.textContent), ["Apertura", "Respuestas", "Resultado"]);
  assert.match(html, /Empieza la consulta ·/);
  assert.match(html, /El clasificador identifica preguntas para responder, sin calificación/);
  assert.match(html, /P1.*¿Cuántos habitantes tiene la Argentina\?/s);
  assert.match(html, /1 pregunta a responder/);
  assert.match(html, /1 síntesis del moderador/);
  assert.match(html, /ChatGPT no se pronunció en la respuesta/);
  assert.match(html, /Termina la consulta ·/);
  assert.doesNotMatch(html, /Síntesis que no se repite en el registro|votos? sobre el contenido completo/);
});

test("Quick individual votes are grouped with results, not with the researched answers", () => {
  const input: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", text: "Afirmación independiente", quote: "" }] },
    ...COUNSEL.map((by): CourtEvent => ({ type: "quick_response", by, text: "Respuesta de " + by, sources: [] })),
    ...COUNSEL.map((by): CourtEvent => ({ type: "vote", by, claimId: "A1", verdict: "verdadero", rationale: "Fundamento individual" })),
    ...COUNSEL.map((by): CourtEvent => ({ type: "content_vote", by, verdict: "enganoso", rationale: "Fundamento global" })),
    { type: "judgment", claimId: "A1", verdict: "verdadero", method: "consensus", reasoning: "" },
    { type: "content_judgment", verdict: "enganoso", method: "consensus", reasoning: "" },
    { type: "session_closed" },
  ];
  const { document } = parseHTML(render(input));
  const sections = [...document.querySelectorAll('[data-fold-scope="section"]')];
  const answers = sections.find((s) => s.querySelector("summary h3")?.textContent === "Respuestas")!;
  const result = sections.find((s) => s.querySelector("summary h3")?.textContent === "Resultado")!;
  assert.doesNotMatch(answers.textContent!, /Fundamento individual/);
  assert.match(result.textContent!, /Fundamento individual/);
  assert.match(result.textContent!, /4 votos por afirmación · 4 votos sobre el contenido completo/);
});
