import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, type CourtEvent, type RecordedEvent, type SeatModels } from "../domain/court.ts";
import { SessionDialogue } from "./case.tsx";
import type { ToolActivity } from "../domain/tool-activity.ts";

const opened: CourtEvent = {
  type: "session_opened",
  judgeModel: "anthropic/claude-opus-5.5",
  counselModels: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" },
};
const claims: CourtEvent = { type: "claims_entered", claims: [{ id: "A1", quote: "Cita original", text: "La afirmación a examinar." }] };

function render(events: CourtEvent[], models?: SeatModels) {
  const recorded: RecordedEvent[] = events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-11-05T14:00:00.000Z" }));
  return parseHTML(renderToStaticMarkup(createElement(SessionDialogue, { events: recorded, caseId: "fixture", models }))).document;
}

test("source collection updates are attributed to the moderator and show failures", () => {
  const document = render([opened, { type: "source_collection_started", total: 5, batches: 2 }, { type: "source_batch_completed", batch: 1, batches: 2, count: 4, completed: 4, total: 5, failed: 1 }]);
  const entries = [...document.querySelector('[role="log"] ol')!.children];
  assert.equal(entries.length, 2);
  assert.match(entries[0].textContent, /Moderador · Claude.*4 de 5; lote 1 de 2.*No se pudo leer 1 enlace/s);
  assert.match(entries[1].textContent, /Moderador · Claude.*comienza a consultar 5 enlaces/s);
});

test("the live timeline shows batch URLs before the fetch and marks unreadable links afterward", () => {
  const urls = ["https://example.test/slow?x=1&y=2", "https://example.test/unreadable"];
  const document = render([opened, { type: "source_batch_started", batch: 1, batches: 1, urls }, { type: "source_batch_completed", batch: 1, batches: 1, count: 2, completed: 2, total: 2, failed: 1, sources: urls.map((url, i) => ({ url, failed: i === 1 })) }]);
  const entries = [...document.querySelector('[role="log"] ol')!.children];
  assert.equal(entries.length, 2);
  assert.match(entries[1].textContent, /Moderador · Claude.*consulta el lote 1 de 1/s);
  assert.deepEqual([...entries[1].querySelectorAll("a")].map((a) => a.getAttribute("href")), urls);
  assert.match(entries[0].textContent, /unreadable · No se pudo leer/);
  assert.ok([...entries[0].querySelectorAll("a")].every((a) => a.getAttribute("rel") === "noreferrer noopener"));
});

test("unsafe recorded URLs are never turned into executable links", () => {
  const document = render([{ type: "source_batch_started", batch: 1, batches: 1, urls: ["javascript:alert(1)", "https://user:pass@example.test/"] }]);
  assert.equal(document.querySelectorAll('[role="log"] a').length, 0);
  assert.match(document.querySelector('[role="log"]')!.textContent, /javascript:alert/);
});

test("the live dialogue prepends the newest complete moderator and analyst messages, without stage folds", () => {
  const statements: CourtEvent[] = COUNSEL.map((by, i) => ({ type: "statement", id: "I" + (i + 1), by, stage: "opening", text: "Intervención completa de " + by + ".\nSegunda línea con el fundamento público sobre A1.", evidenceIds: [] }));
  const document = render([
    opened, claims, { type: "instruction_opened" }, ...statements,
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "La fuente no respalda esa cifra." },
    { type: "objection_reply", objectionId: "O1", by: "grok", text: "Respondo con los datos del documento." },
    { type: "ruling", objectionId: "O1", sustained: false, reason: "El documento sí contiene los datos." },
    { type: "vote", by: "chatgpt", claimId: "A1", verdict: "falso", rationale: "La comparación contradice la afirmación." },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "La evidencia del registro resuelve la diferencia." },
    { type: "content_vote", by: "claude", verdict: null, rationale: "Son afirmaciones independientes." },
    { type: "content_judgment", verdict: "falso", method: "judge", reasoning: "El contenido reproduce la misma afirmación." },
    { type: "case_summary", text: "Resumen final completo del moderador." },
  ]);
  const log = document.querySelector('[role="log"]')!;
  assert.equal(log.getAttribute("aria-live"), "polite");
  assert.equal(log.getAttribute("aria-relevant"), "additions");
  const entries = [...log.querySelector("ol")!.children];
  assert.equal(entries.length, 13);
  assert.ok(entries[0].textContent.includes("Resumen final completo del moderador."), "the latest update starts at the top");
  assert.match(entries.at(-1)!.textContent, /Moderador · Claude.*La afirmación a examinar/s);
  for (const [i, by] of [...COUNSEL].reverse().entries()) {
    assert.ok(entries[i + 8].textContent.includes("Intervención completa de " + by + ".\nSegunda línea con el fundamento público sobre A1."));
    assert.ok(entries[i + 8].querySelector("svg"), "every analyst has their icon");
  }
  assert.ok(entries.at(-1)!.querySelector("svg line"), "the moderator carries the recorded Claude icon");
  assert.ok(entries[5].textContent.includes("El documento sí contiene los datos."));
  assert.ok(entries[6].textContent.includes("Respondo con los datos del documento."));
  assert.ok(entries[7].textContent.includes("La fuente no respalda esa cifra."));
  assert.ok(entries[4].textContent.includes("La comparación contradice la afirmación."));
  assert.ok(entries[3].textContent.includes("La evidencia del registro resuelve la diferencia."));
  assert.ok(entries[2].textContent.includes("Son afirmaciones independientes."));
  assert.ok(entries[1].textContent.includes("El contenido reproduce la misma afirmación."));
  assert.equal(log.querySelectorAll("details").length, 0, "messages are visible without expanding a stage");
  const times = [...log.querySelectorAll("time")];
  assert.equal(times.length, entries.length);
  assert.ok(times.every((t) => t.getAttribute("dateTime") === "2026-11-05T14:00:00.000Z"));
  assert.ok(document.getElementById("A1"), "live claim citations have a target without a result card");
  assert.equal(document.querySelector('#I1 a[href="#A1"]')?.textContent, "A1");
});

test("the live dialogue retains evidence and reliability votes instead of hiding them as in a completed case record", () => {
  const evidence = { id: "P1", by: "grok" as const, claimId: "A1", title: "Informe oficial", url: "https://example.org/report", excerpt: "Fragmento público del informe.", stance: "opposes" as const };
  const document = render([
    opened, claims,
    { type: "evidence_filed", evidence },
    { type: "instruction_completed", by: "grok", searches: [{ claimId: "A1", supporting: "Sin respaldo verificable.", opposing: "Encontré el informe oficial." }] },
    { type: "evidence_unified", sources: [{ id: "E1", title: evidence.title, url: evidence.url, contributions: [evidence] }] },
    { type: "source_review_vote", by: "gemini", sourceId: "E1", veto: false, reason: "La metodología está publicada." },
    { type: "source_decided", sourceId: "E1", excluded: false },
  ]);
  const entries = [...document.querySelector('[role="log"] > ol')!.children];
  assert.equal(entries.length, 5);
  assert.ok(document.getElementById("P1")?.textContent.includes(evidence.excerpt));
  assert.ok(document.getElementById("E1"));
  assert.match(entries[0].textContent, /Gemini.*La metodología está publicada/s);
});

test("refreshing the recorded events adds complete messages and never exposes internal traces or system events", () => {
  const internal = { type: "reasoning", text: "PRIVATE THINKING TRACE" } as unknown as CourtEvent;
  const initial: CourtEvent[] = [opened, internal, { type: "instruction_opened" }];
  const before = render(initial);
  assert.ok(before.querySelector('[role="log"]'), "the empty timeline remains accessible without a visible placeholder");
  assert.equal(before.querySelector('[role="log"] > ol')!.children.length, 0);
  const after = render([...initial, claims, {
    type: "statement", id: "I1", by: "grok", stage: "opening", text: "Mensaje público completo.", evidenceIds: [],
    reasoning: "PRIVATE REASONING FIELD", evidenceRunId: "private-run-id",
  } as CourtEvent, { type: "session_closed" }]);
  assert.equal(after.querySelector('[role="log"] > ol')!.children.length, 2);
  assert.ok(after.querySelector("section")!.textContent.includes("Mensaje público completo."));
  assert.ok(!after.querySelector("section")!.textContent.includes("Esperando la primera intervención"));
  for (const hidden of ["PRIVATE THINKING TRACE", "PRIVATE REASONING FIELD", "private-run-id", "Empieza el debate", "Termina el debate"]) {
    assert.ok(!after.toString().includes(hidden), hidden + " must not reach the live dialogue");
  }
});

test("live speaker icons honor the case snapshot, with fallbacks for older events", () => {
  const overridden = render([opened, claims], { judge: { id: "openai/gpt-6.1-sol", effort: "high" } });
  assert.match(overridden.querySelector('[role="log"] li')!.textContent, /Moderador · ChatGPT/);
  assert.ok(overridden.querySelector('[title="gpt-6.1-sol high"] svg'));
  const fallback = render([claims, { type: "statement", id: "I1", by: "gemini", stage: "opening", text: "Intervención completa.", evidenceIds: [] }]);
  const entries = [...fallback.querySelector('[role="log"] > ol')!.children];
  assert.match(entries.at(-1)!.textContent, /Moderador/);
  assert.ok(entries.at(-1)!.querySelector("svg"), "an unknown moderator gets the gavel");
  assert.match(entries[0].textContent, /Gemini/);
  assert.ok(entries[0].querySelector("svg linearGradient"), "older analyst events keep their family icon");
});

test("a dismissal appears as a complete moderator message", () => {
  const document = render([opened, { type: "dismissed", reason: "El contenido no contiene afirmaciones verificables." }]);
  assert.equal(document.querySelector('[role="log"] > ol')!.children.length, 1);
  assert.match(document.querySelector("section")!.textContent, /Moderador · Claude.*El contenido no contiene afirmaciones verificables/s);
});

test("the timeline merges four tool icons and complete public targets with dialogue, attributed to the caller's provider", () => {
  const at = (second: number) => `2026-11-06T00:00:0${second}.000Z`;
  const events: RecordedEvent[] = [
    { ...claims, seq: 1, at: at(0) },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Complete public statement.", evidenceIds: [], seq: 2, at: at(4) },
  ];
  const base = { schemaVersion: 2 as const, kind: "tool_call" as const, seat: "claude" as const, modelId: "anthropic/calling-model", effort: "high" };
  const activities: ToolActivity[] = [
    { ...base, id: "tool:source", at: at(1), data: { tool: "read_source", url: "https://example.test/report" } },
    { ...base, id: "tool:evidence", at: at(2), data: { tool: "read_evidence", id: "E1", url: "https://example.test/report" } },
    { ...base, id: "tool:web", at: at(3), data: { tool: "web_search", query: "complete search query\nwith a second line" } },
    { ...base, id: "tool:x", at: at(5), data: { tool: "x_search", query: "original public statement <script>not executable</script>" } },
  ];
  const models: SeatModels = { claude: { id: "google/current-config", effort: null } };
  const html = renderToStaticMarkup(createElement(SessionDialogue, { events, caseId: "fixture", activities: [...activities].reverse(), models }));
  const { document } = parseHTML(html);
  const entries = [...document.querySelector('[role="log"] > ol')!.children];
  assert.equal(entries.length, 6);
  assert.ok(entries.at(-1)!.textContent.includes("La afirmación a examinar."));
  assert.ok(entries[1].textContent.includes("Complete public statement."));
  assert.deepEqual(entries.flatMap((entry) => entry.querySelector("[data-tool]")?.getAttribute("data-tool") ?? []), ["x_search", "web_search", "read_evidence", "read_source"]);
  const toolEntries = entries.filter((entry) => entry.querySelector("[data-tool]"));
  for (const entry of toolEntries) {
    assert.match(entry.textContent, /Claude · anthropic/);
    assert.ok(entry.querySelector('[title="calling-model high"] svg line'), "the caller's icon overrides current configuration");
    const row = entry.querySelector("[data-tool]")!;
    assert.doesNotMatch(row.textContent, /read_source|read_evidence|web_search|x_search/, "tool names are not visible");
    assert.equal(row.children.length, 2, "the row contains only the icon and text");
    const text = row.querySelector("p")!;
    assert.ok(text.classList.contains("truncate"), "long targets and multiline queries stay on one line");
    assert.equal(text.getAttribute("title"), text.textContent, "the full text remains available on hover");
  }
  assert.ok(document.querySelector('[data-tool="read_source"] svg circle'));
  assert.equal(document.querySelectorAll('[data-tool="read_evidence"] svg ellipse').length, 2);
  assert.ok(document.querySelector('[data-tool="web_search"] svg circle'));
  assert.ok(document.querySelector('[data-tool="x_search"] svg[fill="currentColor"] path'));
  assert.equal(document.querySelector('[data-tool="read_evidence"] a')?.getAttribute("href"), "/c/fixture/evidence/E1.md");
  assert.equal(document.querySelectorAll('[data-tool="read_evidence"] a')[1].getAttribute("href"), "https://example.test/report");
  assert.ok(document.querySelector('[data-tool="web_search"]')!.textContent.includes("complete search query\nwith a second line"));
  assert.equal(document.querySelector("script"), null);
  assert.ok(html.includes("&lt;script&gt;not executable&lt;/script&gt;"));
});

test("activity can appear before the first court message and preserves court sequence despite timestamp skew", () => {
  const activity: ToolActivity = { schemaVersion: 2, kind: "tool_call", id: "tool:first", at: "2026-11-06T00:00:01.000Z", seat: "judge", modelId: "openai/calling-model", data: { tool: "read_source", url: "https://example.test/submitted" } };
  const html = renderToStaticMarkup(createElement(SessionDialogue, { events: [], caseId: "fixture", activities: [activity] }));
  const { document } = parseHTML(html);
  assert.equal(document.querySelector('[role="log"] > ol')!.children.length, 1);
  assert.match(document.querySelector('[role="log"]')!.textContent, /Moderador · ChatGPT · openai/);
  const events: RecordedEvent[] = [
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "First authoritative message.", evidenceIds: [], seq: 1, at: "2026-11-06T00:00:03.000Z" },
    { type: "statement", id: "I2", by: "gemini", stage: "opening", text: "Second authoritative message.", evidenceIds: [], seq: 2, at: "2026-11-06T00:00:00.000Z" },
  ];
  const merged = parseHTML(renderToStaticMarkup(createElement(SessionDialogue, { events, caseId: "fixture", activities: [activity] }))).document;
  assert.deepEqual([...merged.querySelectorAll('[id^="I"]')].map((element) => element.id), ["I2", "I1"]);
});
