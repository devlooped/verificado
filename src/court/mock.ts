import { tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { MOCK_MODEL_ID } from "./models.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import { project, type CourtEvent, type Submission } from "../domain/court.ts";
import type { TurnSpec } from "./turns.ts";

export function mockAiEnabled(): boolean {
  const mode = process.env.COURT_AI_MODE ?? "live";
  if (mode !== "live" && mode !== "mock") throw new Error("COURT_AI_MODE debe ser live o mock.");
  return mode === "mock";
}

export interface MockTurn {
  spec: TurnSpec;
  record: readonly CourtEvent[];
  submission: Submission;
  shared?: boolean;
  // Pipeline 3: instruction files URL + quote proposals for the host to collect,
  // and both instruction and source review answer in prose, then typed.
  native?: boolean;
}

type Call = { name: string; input: unknown };
const call = (name: string, input: unknown): Call => ({ name, input });
// A typed answer in place of a tool call (the pipeline 3 instruction filing
// and source review), and the prose decision that comes before it.
const OUTPUT = "(typed output)";
const TEXT = "(text)";
const prefix = "SIMULACIÓN LOCAL: ";
const sourceUrl = (claimId: string, side: string) => "https://sources.example.test/" + claimId + "/" + side;

// Fixtures drive the real AI SDK tool loop. They never decide anything about the
// submitted material: every response, source and verdict is explicitly fictitious.
function responses({ spec, record, submission, native }: MockTurn): Call[][] {
  const view = project(record);
  const admitted = [...view.sources.values()].filter((s) => s.excluded === false).map((s) => s.id);
  const statement = () => call("make_statement", {
    text: prefix + "Evaluación ficticia para probar el flujo. Comparo los aportes a favor y en contra del expediente compartido; esto no es una verificación del material enviado.",
    evidenceIds: admitted,
  });
  switch (spec.kind) {
    case "intake": {
      const text = submission.kind === "text" ? submission.text : submission.note ?? (submission.kind === "link" ? submission.url : "Imagen de prueba");
      const enter = [call("enter_claims", { claims: [{ quote: submission.kind === "text" ? submission.text : "", text: prefix + "Afirmación de prueba sobre el material: " + text }] })];
      return submission.kind === "link" ? [[call("web_fetch", { url: submission.url })], enter] : [enter];
    }
    case "instruction": {
      const sides = ["support", "opposition", "unreliable"] as const;
      // The quote is in every fictitious page the mock downloader returns.
      if (native) return [[call(TEXT, prefix + "Decido presentar los documentos ficticios de cada afirmación.")], [call(OUTPUT, {
        proposals: view.claims.flatMap((c) => sides.map((side) => ({
          claimId: c.id, url: sourceUrl(c.id, side), quote: "Documento ficticio con datos 42, sin valor probatorio.",
          stance: side === "support" ? "supports" : side === "opposition" ? "opposes" : "context", commentary: "",
        }))),
        searches: Object.fromEntries(view.claims.map((c) => [c.id, {
          supporting: prefix + "Busqué respaldo a favor y encontré el documento ficticio correspondiente.",
          opposing: prefix + "Busqué evidencia contraria y encontré el documento ficticio correspondiente.",
        }])),
      })]];
      return [
        view.claims.flatMap((c) => [call("web_search", { query: c.id + " pruebas a favor" }), call("web_search", { query: c.id + " pruebas en contra" })]),
        view.claims.flatMap((c) => sides.map((side) => call("web_fetch", { url: sourceUrl(c.id, side) }))),
        view.claims.flatMap((c) => sides.map((side) => call("file_evidence", {
          claimId: c.id,
          title: prefix + (side === "support" ? "Documento a favor" : side === "opposition" ? "Documento en contra" : "Fuente sin autor ni método"),
          url: sourceUrl(c.id, side),
          excerpt: prefix + (side === "support" ? "Datos ficticios que respaldarían la afirmación." : side === "opposition" ? "Datos ficticios que contradirían la afirmación." : "Publicación ficticia sin autoría ni metodología verificable."),
          stance: side === "support" ? "supports" : side === "opposition" ? "opposes" : "context",
        }))),
        [call("finish_instruction", { searches: view.claims.map((c) => ({
          claimId: c.id,
          supporting: prefix + "Busqué respaldo a favor y consulté el documento ficticio correspondiente.",
          opposing: prefix + "Busqué evidencia contraria y consulté el documento ficticio correspondiente.",
        })) })],
      ];
    }
    case "unification": {
      const groups = new Map<string, string[]>();
      for (const e of view.evidence.values()) {
        const url = new URL(e.url);
        url.hash = "";
        groups.set(url.href, [...(groups.get(url.href) ?? []), e.id]);
      }
      return [[call("unify_evidence", { groups: [...groups.values()].map((evidenceIds) => ({ evidenceIds })) })]];
    }
    case "source_review": {
      const votes = [...view.sources.values()].map((s) => {
        const veto = s.url.endsWith("/unreliable") && spec.counsel !== "chatgpt";
        return { sourceId: s.id, veto, reason: prefix + (veto ? "La fuente ficticia no identifica autores ni metodología." : "No veto esta fuente en el escenario de prueba.") };
      });
      if (native) return [[call(TEXT, prefix + "Decido mis votos sobre las fuentes ficticias.")], [call(OUTPUT, { votes })]];
      return [[call("review_sources", { votes })]];
    }
    case "statement":
      return [[statement()]];
    case "objection": {
      const target = record.find((e) => e.type === "statement" && e.id === spec.statementId);
      return [[spec.counsel === "gemini" && target?.type === "statement" && target.stage === "opening" && target.by === "grok"
        ? call("object", { grounds: prefix + "Solicito precisar el alcance del fragmento citado para probar las objeciones." })
        : call("pass", {})]];
    }
    case "reply":
      return [[call("reply_objection", { text: prefix + "Aclaro que los fragmentos son ficticios y solo ilustran el procedimiento." })]];
    case "ruling":
      return [[call("rule", { sustained: false, reason: prefix + "La aclaración responde al planteo del escenario de prueba." })]];
    case "closing":
      return [[statement()], [call("cast_votes", { votes: view.claims.map((c) => ({ claimId: c.id, verdict: "no_verificable", rationale: prefix + "Las fuentes son ficticias: no permiten verificar el material enviado." })) })]];
    case "tiebreak":
      return [[call("decide", { decisions: view.claims.filter((c) => !c.judgment).map((c) => ({ claimId: c.id, verdict: "no_verificable", reasoning: prefix + "Decisión ficticia para probar el desempate; no verifica el material enviado." })) })]];
    case "content_vote":
      return [[call("vote_content", { verdict: "no_verificable", rationale: prefix + "Las fuentes ficticias no verifican el contenido completo." })]];
    case "content_tiebreak":
      return [[call("decide_content", { verdict: "no_verificable", reasoning: prefix + "Decisión ficticia sobre el contenido completo, sin verificación real." })]];
    case "summary":
      return [[call("summarize_case", { text: prefix + "Los analistas contrastaron pruebas ficticias a favor y en contra; no verificaron el material enviado." })]];
  }
}

// A Quick check: the analyst's answer in prose, its typed vote on the whole
// content, and the moderator's tie-break. Every analyst votes the same way, so a
// simulated case resolves by consensus.
export function createQuickMockModel(step: "claims" | "answer" | "vote" | "tiebreak") {
  const text = step === "answer"
    ? prefix + "Respuesta ficticia para probar el chequeo rápido; no busqué ni verifiqué el material enviado.\nLas fuentes de esta simulación no existen."
    : JSON.stringify(step === "claims"
      ? { claims: [{ quote: "", text: prefix + "Primera afirmación ficticia para probar el flujo." }, { quote: "", text: prefix + "Segunda afirmación ficticia para probar el flujo." }] }
      : step === "vote"
      ? { verdict: "no_verificable", rationale: prefix + "La respuesta es ficticia: no verifica el contenido enviado." }
      : { verdict: "no_verificable", reasoning: prefix + "Desempate ficticio, sin verificación real." });
  return new MockLanguageModelV4({
    provider: "local-mock",
    modelId: MOCK_MODEL_ID,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
      warnings: [],
    }),
  });
}

export function createMockSeat(turn: MockTurn, search: boolean) {
  const script = responses(turn).map((step) => step.map((call) => {
    if (!turn.shared) return call;
    if (call.name === "web_fetch") return { ...call, name: "read_source" };
    if (call.name === "unify_evidence") return { ...call, input: {} };
    if (call.name === "file_evidence") {
      const input = call.input as { url: string; claimId: string; stance: string };
      return { ...call, input: { sourceId: `src_${createHash("sha256").update(input.url).digest("hex").slice(0, 24)}`, blockIds: ["p1:b1"], claimId: input.claimId, stance: input.stance } };
    }
    return call;
  }));
  let generation = 0;
  const model = new MockLanguageModelV4({
    provider: "local-mock",
    modelId: MOCK_MODEL_ID,
    doGenerate: async () => {
      const index = generation++;
      const calls = script[index] ?? [];
      if (calls[0]?.name === OUTPUT || calls[0]?.name === TEXT) return {
        content: [{ type: "text" as const, text: calls[0].name === TEXT ? String(calls[0].input) : JSON.stringify(calls[0].input) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        warnings: [],
      };
      return {
        content: calls.length
          ? calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `mock-${index}-${i}`, toolName: c.name, input: JSON.stringify(c.input) }))
          : [{ type: "text" as const, text: prefix + "Fin de las respuestas simuladas." }],
        finishReason: { unified: calls.length ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const research: ToolSet = {
    web_fetch: tool({
      description: "Lee una página ficticia sin usar la red.",
      inputSchema: z.object({ url: z.url() }),
      execute: async ({ url }) => ({ url, content: prefix + "Documento de prueba con aportes a favor y en contra; no es evidencia real." }),
    }),
  };
  if (search) {
    const searchTool = tool({
      description: "Busca fuentes ficticias sin usar la red.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ query, results: ["support", "opposition", "unreliable"].map((side) => ({ title: prefix + side, url: sourceUrl(query.match(/\bA\d+\b/)?.[0] ?? "A1", side) })) }),
    });
    research.web_search = searchTool;
    research.x_search = searchTool;
  }
  return { model, research };
}
