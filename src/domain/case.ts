import { COUNSEL, MODEL_NAME, modelName, project, type Answer, type CaseRecord, type CaseView, type CourtEvent, type Stage, type Submission, type Verdict } from "./court.ts";

export function submissionExcerpt(s: Submission): string {
  if (s.kind === "text") return s.text;
  if (s.kind === "link") return s.note ? s.note + " · " + s.url : s.url;
  return s.note ?? "Imagen";
}

// What the panel did with the material: one kind of check, whatever court
// recorded it, or questions answered by the panel.
export function caseKindLabel(view: Pick<CaseView, "contentKind">): string {
  return view.contentKind === "question" ? "Consulta" : "Chequeo";
}

export const STAGE_LABEL: Record<Stage, string> = {
  opening: "exposición inicial",
  rebuttal: "réplica",
  closing: "conclusión",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  verdadero: "Verdadero",
  falso: "Falso",
  no_verificable: "Insostenible",
  enganoso: "Engañoso",
};

// Questions are answered with the same four codes: Sí, No, Depende (it depends,
// it is debated, there is no consensus) and No sé (the evidence is not enough);
// and Dato, when the question asks for a fact or a figure the evidence gives.
export const ANSWER_LABEL: Record<Answer, string> = {
  verdadero: "Sí",
  falso: "No",
  no_verificable: "No sé",
  enganoso: "Depende",
  dato: "Dato",
};

export function answerLabel(verdict: Answer): string {
  return ANSWER_LABEL[verdict];
}

export const ANSWER_THUMB: Record<Answer, string> = {
  verdadero: "👍",
  falso: "👎",
  no_verificable: "❓",
  enganoso: "🤔",
  dato: "📊",
};

export const VERDICT_THUMB: Record<Verdict, string> = {
  verdadero: "👍",
  falso: "👎",
  no_verificable: "❓",
  enganoso: "⚠️",
};

// The case at a glance: one verdict when every judged claim agrees, "mixto" when they differ.
export function caseOutcome(view: Pick<CaseView, "claims">): Verdict | "mixto" | undefined {
  const verdicts = new Set(view.claims.flatMap((c) => (c.judgment ? [c.judgment.verdict] : [])));
  if (verdicts.size === 0) return undefined;
  return verdicts.size === 1 ? [...verdicts][0] : "mixto";
}

// The answers to the questions at a glance: one when every rated question has
// the same, "mixto" when they differ.
export function answersOutcome(view: Pick<CaseView, "questions" | "answerJudgment">): Answer | "mixto" | undefined {
  const judgments = view.questions.length ? view.questions.map((q) => q.judgment) : [view.answerJudgment];
  const verdicts = new Set(judgments.flatMap((j) => (j ? [j.verdict] : [])));
  if (verdicts.size === 0) return undefined;
  return verdicts.size === 1 ? [...verdicts][0] : "mixto";
}

// Old records have no structured content votes. Recognize only the explicit,
// unanimous statement recorded in this historical moderator summary; do not
// manufacture individual votes or infer a verdict from the claim outcomes.
export function contentOutcome(view: Pick<CaseView, "contentJudgment" | "contentVotingRecorded" | "summary" | "dismissal">): { verdict: Verdict; method: "consensus" | "judge" | "reported" } | undefined {
  if (view.dismissal) return undefined;
  if (view.contentJudgment) return view.contentJudgment;
  if (!view.contentVotingRecorded && view.summary?.includes("Los cuatro analistas coincidieron en considerar engañoso el enunciado completo."))
    return { verdict: "enganoso", method: "reported" };
  return undefined;
}

export function caseShareMetadata(c: CaseRecord, events: readonly CourtEvent[] = []): { title: string; description: string } {
  const title = "Caso Nº " + c.id + " · CheBot";
  const view = c.status === "resolved" ? project(events) : undefined;
  const claims = view?.claims.map((claim) => claim.text).filter(Boolean) ?? [];
  const quoted = `«${claims.length ? claims.join(" / ") : submissionExcerpt(c.submission)}»`;
  const questions = view?.contentKind === "question";
  const outcome = view && !view.dismissal ? questions ? answersOutcome(view) : contentOutcome(view)?.verdict ?? caseOutcome(view) : undefined;
  const icon = outcome === "mixto" ? "⚖️" : outcome === undefined ? undefined : questions || outcome === "dato" ? ANSWER_THUMB[outcome] : VERDICT_THUMB[outcome];
  return icon
    ? { title: `${title} · ${icon}`, description: `${quoted} ${icon}` }
    : { title, description: quoted };
}

export const ABSENCE_LABEL = { ...STAGE_LABEL, discovery: "investigación", instruction: "instrucción", source_review: "crítica de fuentes", objection: "ronda de objeciones", content: "votación del contenido completo", answer: "respuesta", answer_vote: "votación de las respuestas" };
export const EVIDENCE_STANCE_LABEL = { supports: "a favor", opposes: "en contra", context: "contexto" };

export function describe(e: CourtEvent): string {
  switch (e.type) {
    case "session_opened":
      return (e.simulated ? "SIMULACIÓN LOCAL: respuestas y fuentes ficticias. " : "") + "Empieza el debate. Modera " + modelName(e.judgeModel) + ". Participan " + Object.keys(e.counselModels).map((c) => MODEL_NAME[c as keyof typeof MODEL_NAME]).join(", ") + ".";
    case "claims_entered":
      return "El moderador fija las afirmaciones a examinar:\n" + e.claims.map((c) => "[" + c.id + "] " + c.text).join("\n");
    case "content_classified":
      return "El clasificador identifica " + (e.kind === "question" ? "preguntas para responder" : "afirmaciones para chequear") + (e.items.length ? ":\n" + e.items.map((c) => "[" + c.id + "] " + c.text).join("\n") : ", sin separarlas: se trata el material completo.");
    case "dismissed":
      return "El moderador descarta el caso: " + e.reason;
    case "instruction_opened":
      return "Empieza la instrucción: aporte de pruebas a favor y en contra de cada afirmación, sin argumentaciones.";
    case "evidence_filed":
      return "[" + e.evidence.id + "] " + MODEL_NAME[e.evidence.by] + " presenta evidencia sobre " + e.evidence.claimId + (e.evidence.stance ? " (" + EVIDENCE_STANCE_LABEL[e.evidence.stance] + ")" : "") + ": " + e.evidence.title + " (" + e.evidence.url + "). " + e.evidence.excerpt;
    case "evidence_proposed":
      return MODEL_NAME[e.by] + " propone una fuente sobre " + e.proposal.claimId + " (" + EVIDENCE_STANCE_LABEL[e.proposal.stance] + "): " + e.proposal.url + " «" + e.proposal.quote + "»";
    case "instruction_completed":
      return MODEL_NAME[e.by] + " cierra sus aportes de instrucción:\n" + e.searches.map((s) => s.claimId + " — búsqueda a favor: " + s.supporting + "; búsqueda en contra: " + s.opposing).join("\n");
    case "source_collection_started":
      return e.total ? "El moderador comienza a consultar " + e.total + (e.total === 1 ? " enlace propuesto." : " enlaces propuestos.") : "El moderador inicia la recopilación de fuentes: no se propusieron enlaces.";
    case "source_batch_started":
      return "El moderador consulta el lote " + e.batch + " de " + e.batches + ".";
    case "source_batch_completed":
      return "El moderador consultó " + e.count + (e.count === 1 ? " enlace" : " enlaces") + " (" + e.completed + " de " + e.total + "; lote " + e.batch + " de " + e.batches + ")." + (e.failed ? " No se pudo leer " + e.failed + (e.failed === 1 ? " enlace." : " enlaces.") : "");
    case "evidence_unified":
      return "El moderador unifica las pruebas para la crítica de fuentes:\n" + (e.sources.map((s) =>
        "[" + s.id + "] " + s.title + " (" + s.url + "). Aportes: " + s.contributions.map((c) => c.id + " de " + MODEL_NAME[c.by] + " sobre " + c.claimId + ": " + c.excerpt).join("; ")
      ).join("\n") || "Sin pruebas aportadas.");
    case "source_review_vote":
      return MODEL_NAME[e.by] + " vota " + (e.veto ? "vetar" : "no vetar") + " la fuente " + e.sourceId + ": " + e.reason;
    case "source_decided":
      return "Fuente " + e.sourceId + ": " + (e.excluded ? "ANULADA por mayoría absoluta (al menos 3 de 4 votos); no puede usarse como prueba." : "admitida; no hubo mayoría absoluta para anularla.");
    case "instruction_closed":
      return "Termina la instrucción. El expediente común queda cerrado antes de las exposiciones; solo pueden citarse fuentes admitidas.";
    case "evidence_settled":
      return "Expediente de evidencia fijado y verificado (versión 2).";
    case "floor_granted":
      return "El moderador da la palabra a " + MODEL_NAME[e.to] + " para su " + STAGE_LABEL[e.stage] + ".";
    case "statement":
      return "[" + e.id + "] " + MODEL_NAME[e.by] + " (" + STAGE_LABEL[e.stage] + "): " + e.text + (e.evidenceIds.length ? " [cita " + e.evidenceIds.join(", ") + "]" : "");
    case "quick_response":
      return MODEL_NAME[e.by] + " responde:\n" + e.text + (e.sources.length ? "\nFuentes citadas: " + e.sources.map((s) => s.url).join(", ") : "");
    case "objection":
      return "[" + e.id + "] " + MODEL_NAME[e.by] + " objeta " + e.against + ": " + e.grounds;
    case "objection_reply":
      return MODEL_NAME[e.by] + " responde a la objeción " + e.objectionId + ": " + e.text;
    case "ruling":
      return "El moderador resuelve la objeción " + e.objectionId + ": " + (e.sustained ? "aceptada, se anula la intervención objetada. " : "rechazada. ") + e.reason;
    case "vote":
      return MODEL_NAME[e.by] + " vota " + VERDICT_LABEL[e.verdict] + " sobre " + e.claimId + ": " + e.rationale;
    case "judgment":
      return "Resultado de " + e.claimId + ": " + VERDICT_LABEL[e.verdict] + (e.method === "consensus" ? " (por mayoría)." : " (desempate del moderador). " + e.reasoning);
    case "content_vote":
      return MODEL_NAME[e.by] + (e.verdict ? " vota " + VERDICT_LABEL[e.verdict] + " sobre el contenido completo" : " considera que no corresponde un voto sobre el contenido completo") + ": " + e.rationale;
    case "content_judgment":
      return "Resultado del contenido completo: " + VERDICT_LABEL[e.verdict] + (e.method === "consensus" ? " (por mayoría)." : " (desempate del moderador). " + e.reasoning);
    case "case_summary":
      return "Resumen del moderador: " + e.text;
    case "answer_synthesis":
      return "Síntesis del moderador" + (e.questionId ? " sobre " + e.questionId : "") + " (" + (e.majority ? "opinión mayoritaria" : "sin mayoría: posiciones del panel") + "): " + e.text;
    case "answer_vote":
      return MODEL_NAME[e.by] + " responde " + ANSWER_LABEL[e.verdict] + (e.questionId ? " sobre " + e.questionId : "") + ": " + e.rationale;
    case "answer_judgment":
      return "Respuesta del panel" + (e.questionId ? " a " + e.questionId : "") + ": " + answerLabel(e.verdict) + (e.method === "consensus" ? " (por mayoría)." : " (desempate del moderador). " + e.reasoning);
    case "absence":
      return MODEL_NAME[e.by] + " no se pronunció en la " + ABSENCE_LABEL[e.stage] + ".";
    case "session_closed":
      return "Termina el debate.";
  }
}