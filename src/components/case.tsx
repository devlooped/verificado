import { ABSENCE_LABEL, describe, EVIDENCE_STANCE_LABEL, STAGE_LABEL, VERDICT_LABEL } from "@/domain/case.ts";
import { canonicalUrl } from "@/instruction/proposed-urls.ts";
import { COUNSEL, MODEL_NAME, modelDetail, modelMark, modelName, project, seatModels, type CaseView, type Counsel, type Evidence, type RecordedEvent, type Seat, type SeatModels, type SourceView, type Stage } from "@/domain/court.ts";
import { FoldButtons, FoldNavigation } from "./case-folding.tsx";
import { CitationLink, Cited, citationHref, citationRefs, mentions, type Citations } from "./citations.tsx";
import { GavelIcon, JudgeSeal, ModelMark, VERDICT_TEXT, VerdictGlyph, VoteChip } from "./marks.tsx";
import type { ToolActivity } from "@/domain/tool-activity.ts";
import { ToolActivityEntry } from "./tool-activity.tsx";

const time = (at: string) =>
  new Date(at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });

interface Context extends Citations {
  view: CaseView;
  sourceAliases: ReadonlyMap<string, string>;
  models: SeatModels;
  live?: boolean;
}

function Speaker({ by, small }: { by: Counsel; small?: boolean }) {
  return (
    <span className="flex w-9 shrink-0 justify-center">
      <span className={"grid shrink-0 place-items-center rounded-full border border-rule bg-paper " + (small ? "size-5" : "size-9")}>
        <ModelMark model={by} className={small ? "size-3" : "size-5"} />
      </span>
    </span>
  );
}

function Chevron() {
  return (
    <svg className="fold-chevron size-3.5 shrink-0 text-ink-soft transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Clerk({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">{children}</p>;
}

function OriginalEvidence({ evidence }: { evidence: Evidence }) {
  if (!evidence.translation) return null;
  return (
    <details className="mt-1 text-xs text-ink-soft">
      <summary className="cursor-pointer text-celeste-deep">Traducción automática · ver original aportado</summary>
      <p className="mt-1 font-semibold">{evidence.translation.original.title}</p>
      <p>{evidence.translation.original.excerpt}</p>
    </details>
  );
}

function Source({ source, ctx }: { source: SourceView; ctx: Context }) {
  const contributors = COUNSEL.filter((c) => source.contributions.some((e) => e.by === c));
  const vetoes = COUNSEL.filter((c) => source.votes[c]?.veto).length;
  return (
    <details open id={source.id} className="fold scroll-mt-24 rounded-sm border border-rule bg-paper/60 px-4 py-3 target:ring-2 target:ring-celeste">
      <summary className="fold-summary flex cursor-pointer items-start gap-2">
        {ctx.sourceAliases.has(source.id) && <span id={ctx.sourceAliases.get(source.id)} className="scroll-mt-24" />}
        <span className="mt-0.5"><Chevron /></span>
        <span className="min-w-0">
          <span className="block text-xs text-ink-soft">
            <span className="font-mono font-medium text-ink">{source.id}</span>{" · "}
            <span className={source.excluded ? "font-semibold text-seal" : "font-semibold"}>
              {source.excluded ? "Anulada" : source.excluded === false ? "Admitida" : "Pendiente de crítica"}
            </span>
            {source.excluded !== undefined && " · " + vetoes + "/4 votos por anular"}
          </span>
          <a href={source.url} target="_blank" rel="noreferrer noopener" className="mt-1 block font-medium text-celeste-deep underline underline-offset-2">{source.title}</a>
        </span>
      </summary>
      <div className="pl-5.5">
        <p className="mt-1 text-xs text-ink-soft">Aportada por {contributors.map((c) => MODEL_NAME[c]).join(", ")}</p>
        <ul className="mt-2 space-y-2 text-sm">
          {source.contributions.map((e) => (
            <li key={e.id} className={source.excluded ? "struck text-ink-soft" : "text-ink-soft"}>
              <span className="font-semibold">{MODEL_NAME[e.by]} · <Cited text={e.claimId} ctx={ctx} /> · {EVIDENCE_STANCE_LABEL[e.stance ?? "context"]}:</span> {e.excerpt}
              <OriginalEvidence evidence={e} />
            </li>
          ))}
        </ul>
        {source.excluded && <p className="mt-2 text-sm font-semibold text-seal">No puede usarse como prueba en las exposiciones ni en el resultado.</p>}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-celeste-deep">Votos y fundamentos sobre la confiabilidad</summary>
          <ul className="mt-2 space-y-1">
            {COUNSEL.map((c) => (
              <li key={c}>
                <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
                {source.votes[c] ? <>{source.votes[c].veto ? "Vetar" : "No vetar"}. <Cited text={source.votes[c].reason} ctx={ctx} /></> : "No votó."}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}

function Statement({ e, ctx }: { e: Extract<RecordedEvent, { type: "statement" }>; ctx: Context }) {
  const struck = ctx.view.struck.has(e.id);
  const mentioned = new Set(mentions(e.text, ctx).map((m) => m.token));
  // Citations the analyst declared without mentioning them in the text keep a discreet link.
  const unmentioned = e.evidenceIds.filter((id) => !mentioned.has(id));
  return (
    <div id={e.id} className="scroll-mt-24 target:ring-2 target:ring-celeste">
      <p className="mb-1"><CitationLink id={e.id} href={"#" + e.id} /></p>
      <p className={"whitespace-pre-line font-display text-lg leading-snug " + (struck ? "struck" : "")}><Cited text={e.text} ctx={ctx} /></p>
      {unmentioned.length > 0 && (
        <p className="mt-1 text-xs text-ink-soft">
          También cita:{" "}
          {unmentioned.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <CitationLink id={id} href={citationHref(id, ctx) ?? "#" + id} />
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// A Quick check: the analyst's whole answer, as plain text, and the pages its
// provider cited (not sources reviewed by the panel).
function QuickResponse({ e }: { e: Extract<RecordedEvent, { type: "quick_response" }> }) {
  return (
    <div id={"respuesta-" + e.by} className="scroll-mt-24 target:ring-2 target:ring-celeste">
      <p className="whitespace-pre-line leading-relaxed">{e.text}</p>
      {e.sources.length > 0 && (
        <div className="mt-3 text-xs text-ink-soft">
          <p>Fuentes que citó {MODEL_NAME[e.by]}:</p>
          <ul className="mt-1 space-y-1">
            {e.sources.map((s) => (
              <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener" className="break-all text-celeste-deep underline underline-offset-2">{s.title || s.url}</a></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Entry({ e, ctx }: { e: RecordedEvent; ctx: Context }) {
  const { view } = ctx;
  const quick = Object.keys(view.responses).length > 0;
  switch (e.type) {
    case "session_opened":
      return <Clerk>{e.simulated && "Simulación local · fuentes y respuestas ficticias · "}{quick ? "Empieza el chequeo rápido" : "Empieza el debate"} · {time(e.at)}</Clerk>;
    case "quick_response":
      return <QuickResponse e={e} />;
    case "claims_entered":
      return (
        <div className="flex gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-seal text-paper"><GavelIcon className="size-4" /></span>
          <div>
            <p className="text-sm font-semibold">El moderador fija las afirmaciones a examinar</p>
            <ol className="mt-1 space-y-1 text-sm">
              {e.claims.map((c) => <li key={c.id} id={ctx.live ? c.id : undefined}><Cited text={c.id} ctx={ctx} /> <Cited text={c.text} ctx={ctx} /></li>)}
            </ol>
          </div>
        </div>
      );
    case "dismissed":
      return (
        <div className="flex gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-seal text-paper"><GavelIcon className="size-4" /></span>
          <p className="text-sm"><span className="font-semibold">El moderador descarta el caso.</span> <Cited text={e.reason} ctx={ctx} /></p>
        </div>
      );
    case "evidence_filed":
      return (
        <div id={e.evidence.id} className="scroll-mt-24 rounded-sm border border-rule bg-paper/60 px-4 py-3 target:ring-2 target:ring-celeste">
          <div className="flex items-center gap-2 text-xs text-ink-soft">
            <span className="font-mono font-medium text-ink">{e.evidence.id}</span>
            <ModelMark model={e.evidence.by} className="size-3.5" />
            <span>Aporte de {MODEL_NAME[e.evidence.by]} sobre <Cited text={e.evidence.claimId} ctx={ctx} />{e.evidence.stance && " · " + EVIDENCE_STANCE_LABEL[e.evidence.stance]}</span>
          </div>
          <a href={e.evidence.url} target="_blank" rel="noreferrer noopener" className="mt-1 block font-medium text-celeste-deep underline decoration-celeste/40 underline-offset-2 hover:decoration-celeste-deep">
            {e.evidence.title}
          </a>
          <p className="mt-1 text-sm text-ink-soft">{e.evidence.excerpt}</p>
          <OriginalEvidence evidence={e.evidence} />
        </div>
      );
    case "instruction_opened":
    case "evidence_proposed":
      return null;
    case "source_collection_started":
      return <p className="text-sm text-ink-soft">{describe(e)}</p>;
    case "source_batch_started":
    case "source_batch_completed": {
      const sources: { url: string; failed?: boolean }[] = e.type === "source_batch_started" ? e.urls.map((url) => ({ url })) : e.sources ?? [];
      return (
        <div className="text-sm text-ink-soft">
          <p>{describe(e)}</p>
          {sources.length > 0 && <ul className="mt-2 space-y-1">{sources.map((source, i) => {
            const href = canonicalUrl(source.url);
            return <li key={i} className="break-all">{href ? <a href={href} target="_blank" rel="noreferrer noopener" className="text-celeste-deep underline underline-offset-2">{source.url}</a> : source.url}{source.failed && <span className="text-seal"> · No se pudo leer</span>}</li>;
          })}</ul>}
        </div>
      );
    }
    case "instruction_completed":
      return (
        <details className="text-sm text-ink-soft">
          <summary className="cursor-pointer">{MODEL_NAME[e.by]} cierra sus aportes · búsquedas en ambos sentidos</summary>
          <ul className="mt-2 space-y-2">
            {e.searches.map((s) => <li key={s.claimId}><Cited text={s.claimId} ctx={ctx} /><p>A favor: <Cited text={s.supporting} ctx={ctx} /></p><p>En contra: <Cited text={s.opposing} ctx={ctx} /></p></li>)}
          </ul>
        </details>
      );
    case "evidence_unified":
      return (
        <div className="space-y-3">
          <p className="font-semibold">El moderador unifica las pruebas · expediente común</p>
          <p className="text-sm text-ink-soft">Cada fuente conserva los aportes de todos los analistas. A continuación se vota su confiabilidad.</p>
          {e.sources.map((s) => <Source key={s.id} source={view.sources.get(s.id)!} ctx={ctx} />)}
          {!e.sources.length && <p className="text-sm text-ink-soft">No se aportaron pruebas.</p>}
        </div>
      );
    case "source_review_vote":
      return <p className="text-sm"><span className="font-semibold">{MODEL_NAME[e.by]}</span> vota {e.veto ? "vetar" : "no vetar"} <a href={"#" + e.sourceId} className="font-mono text-celeste-deep hover:underline">{e.sourceId}</a>: <span className="text-ink-soft"><Cited text={e.reason} ctx={ctx} /></span></p>;
    case "source_decided":
      return <p className={"text-sm " + (e.excluded ? "text-seal" : "text-ink-soft")}><a href={"#" + e.sourceId} className="font-mono hover:underline">{e.sourceId}</a>: {e.excluded ? "anulada por mayoría (al menos 3 de 4 votos)." : "admitida; no hubo mayoría para anularla."}</p>;
    case "instruction_closed":
      return <Clerk>Termina la instrucción · fuentes fijadas para las exposiciones</Clerk>;
    case "evidence_settled":
      return <Clerk>Evidencia fijada · <a href={`/c/${encodeURIComponent(ctx.caseId)}/evidence/index.md`} className="underline">Índice del corpus admitido</a></Clerk>;
    case "floor_granted":
      return <Clerk>El moderador da la palabra a {MODEL_NAME[e.to]} · {STAGE_LABEL[e.stage]}</Clerk>;
    case "statement":
      return <Statement e={e} ctx={ctx} />;
    case "objection":
      return (
        <div id={e.id} className="scroll-mt-24 border-l-4 border-seal pl-4 target:ring-2 target:ring-celeste">
          <p className="font-display text-xl italic text-seal">Objeción <span className="not-italic"><CitationLink id={e.id} href={"#" + e.id} /></span></p>
          <p className="text-sm">
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> objeta <a href={"#" + e.against} className="font-mono text-celeste-deep hover:underline">{e.against}</a>: <Cited text={e.grounds} ctx={ctx} />
          </p>
        </div>
      );
    case "objection_reply":
      return (
        <div className="pl-5 text-sm">
          <span className="font-semibold">{MODEL_NAME[e.by]}</span> responde a <Cited text={e.objectionId} ctx={ctx} />: <span className="text-ink-soft"><Cited text={e.text} ctx={ctx} /></span>
        </div>
      );
    case "ruling":
      return (
        <div className="flex items-start gap-2 pl-5 text-sm">
          <GavelIcon className="mt-0.5 size-4 shrink-0 text-seal" />
          <p>
            <span className={"font-bold uppercase tracking-wide " + (e.sustained ? "text-seal" : "text-ink")}>{e.sustained ? "Objeción aceptada" : "Objeción rechazada"}</span> (<Cited text={e.objectionId} ctx={ctx} />).{" "}
            <span className="text-ink-soft"><Cited text={e.reason} ctx={ctx} /></span>
          </p>
        </div>
      );
    case "vote":
      return (
        <div className="flex items-start gap-2 text-sm">
          <ModelMark model={e.by} className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> vota <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span> sobre <Cited text={e.claimId} ctx={ctx} />. <span className="text-ink-soft"><Cited text={e.rationale} ctx={ctx} /></span>
          </p>
        </div>
      );
    case "judgment": {
      const votes = view.claims.find((claim) => claim.id === e.claimId)?.votes ?? {};
      const voted = COUNSEL.some((c) => votes[c]);
      const ordered = [
        ...COUNSEL.filter((c) => votes[c]?.verdict === e.verdict),
        ...COUNSEL.filter((c) => votes[c] && votes[c].verdict !== e.verdict),
        ...COUNSEL.filter((c) => !votes[c]),
      ];
      return e.method === "judge" ? (
        <div className="flex items-start gap-4 rounded-sm border border-seal/40 bg-seal/5 p-4">
          <JudgeSeal verdict={e.verdict} judge={ctx.models.judge} />
          <p className="text-sm">
            <span className="font-semibold">Desempate del moderador sobre <Cited text={e.claimId} ctx={ctx} />: </span>
            <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}.</span> <span className="text-ink-soft"><Cited text={e.reasoning} ctx={ctx} /></span>
          </p>
        </div>
      ) : (
        <p className="flex flex-wrap items-center justify-center gap-2 text-sm">
          <span className={VERDICT_TEXT[e.verdict]}><VerdictGlyph verdict={e.verdict} className="size-4" /></span>
          <span>Resultado de <Cited text={e.claimId} ctx={ctx} />: <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span>{!voted && ", por mayoría."}</span>
          {voted && <span role="group" aria-label={"Votos de los analistas sobre " + e.claimId} className="inline-flex items-center gap-1.5">
            {ordered.map((c) => votes[c] ? (
              <a key={c} href={"#voto-" + e.claimId + "-" + c} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + VERDICT_LABEL[votes[c].verdict]} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep">
                <VoteChip model={c} verdict={votes[c].verdict} used={ctx.models[c]} size="sm" />
              </a>
            ) : <VoteChip key={c} model={c} used={ctx.models[c]} size="sm" />)}
          </span>}
        </p>
      );
    }
    case "content_vote":
      return (
        <div className="flex items-start gap-2 text-sm">
          <ModelMark model={e.by} className="mt-0.5 size-4 shrink-0" />
          <p><span className="font-semibold">{MODEL_NAME[e.by]}</span>{e.verdict ? <> vota <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span> sobre el contenido completo.</> : " considera que no corresponde un voto sobre el contenido completo."}{" "}<span className="text-ink-soft"><Cited text={e.rationale} ctx={ctx} /></span></p>
        </div>
      );
    case "content_judgment":
      return <p className="text-sm"><span className="font-semibold">Resultado del contenido completo:</span>{" "}<span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span>{e.method === "judge" ? <> · Desempate del moderador. <Cited text={e.reasoning} ctx={ctx} /></> : " · Por mayoría."}</p>;
    case "case_summary":
      return (
        <div className="text-sm">
          <p className="font-semibold">Resumen del moderador</p>
          <p className="mt-1 whitespace-pre-line text-ink-soft"><Cited text={e.text} ctx={ctx} /></p>
        </div>
      );
    case "absence":
      return <Clerk>{MODEL_NAME[e.by]} no se pronunció en la {ABSENCE_LABEL[e.stage]}</Clerk>;
    case "session_closed":
      return <Clerk>{quick ? "Termina el chequeo" : "Termina el debate"} · {time(e.at)}</Clerk>;
  }
}

// Entries that hang from a speaker above them sit indented under the speakers' column.
const INDENTED = new Set<RecordedEvent["type"]>([
  "evidence_filed", "instruction_completed", "evidence_unified", "source_review_vote", "source_decided",
  "objection", "objection_reply", "ruling", "vote", "content_vote", "case_summary",
]);

type SectionKey = "apertura" | "respuestas" | "instruccion" | "recopilacion" | "fuentes" | Stage | "resultado";

const SECTION_TITLE: Record<SectionKey, string> = {
  apertura: "Apertura",
  respuestas: "Respuestas",
  instruccion: "Instrucción",
  recopilacion: "Fuentes",
  fuentes: "Crítica de fuentes",
  opening: "Exposiciones iniciales",
  rebuttal: "Réplicas",
  closing: "Conclusiones y votos",
  resultado: "Resultado",
};

// One analyst's run within a stage: the contributions of the instruction up to their
// closing, or a turn of the debate with its objections and votes.
interface Group {
  kind: "group";
  by: Counsel;
  seq: number;
  stage?: Stage;
  events: RecordedEvent[];
  closing?: Extract<RecordedEvent, { type: "instruction_completed" }>;
}
type Item = { kind: "event"; e: RecordedEvent } | Group;
interface Section {
  key: SectionKey;
  events: RecordedEvent[];
}

function sectionsOf(events: readonly RecordedEvent[]): Section[] {
  const sections: Section[] = [];
  let key: SectionKey = "apertura";
  for (const e of events) {
    if (e.type === "quick_response") key = "respuestas";
    else if (e.type === "instruction_opened") key = "instruccion";
    else if (e.type === "source_collection_started" || e.type === "source_batch_started" || e.type === "source_batch_completed") key = "recopilacion";
    else if ((e.type === "evidence_filed" || e.type === "instruction_completed") && key === "apertura") key = "instruccion";
    else if (e.type === "evidence_unified") key = "fuentes";
    else if (e.type === "floor_granted" || e.type === "statement") key = e.stage;
    else if (e.type === "judgment" || e.type === "content_vote" || e.type === "content_judgment" || e.type === "session_closed") key = "resultado";
    const last = sections.at(-1);
    if (last?.key === key) last.events.push(e);
    else sections.push({ key, events: [e] });
  }
  return sections;
}

function itemsOf(section: Section): Item[] {
  const items: Item[] = [];
  let group: Group | undefined;
  const open = (by: Counsel, e: RecordedEvent, stage?: Stage): Group => {
    group = { kind: "group", by, seq: e.seq, stage, events: [] };
    items.push(group);
    return group;
  };
  for (const e of section.events) {
    if (e.type === "instruction_opened") continue;
    if (section.key === "instruccion") {
      const by = e.type === "evidence_filed" ? e.evidence.by : e.type === "instruction_completed" || e.type === "absence" ? e.by : undefined;
      if (!by) {
        group = undefined;
        items.push({ kind: "event", e });
        continue;
      }
      const current = group && group.by === by && !group.closing ? group : open(by, e);
      if (e.type === "instruction_completed") current.closing = e;
      else current.events.push(e);
    } else if (section.key === "opening" || section.key === "rebuttal" || section.key === "closing") {
      if (e.type === "floor_granted") {
        open(e.to, e, e.stage);
        continue;
      }
      const hasStatement = group?.events.some((x) => x.type === "statement");
      if (e.type === "statement" && (!group || group.by !== e.by || hasStatement)) open(e.by, e, e.stage);
      const thread = e.type === "objection" || e.type === "objection_reply" || e.type === "ruling" || (e.type === "absence" && e.stage === "objection");
      const own = (e.type === "statement" || e.type === "vote" || e.type === "absence" || e.type === "evidence_filed") && (e.type === "evidence_filed" ? e.evidence.by : e.by) === group?.by;
      if (group && (thread || own)) group.events.push(e);
      else {
        group = undefined;
        items.push({ kind: "event", e });
      }
    } else if (section.key === "respuestas" && e.type === "quick_response") {
      open(e.by, e).events.push(e);
    } else items.push({ kind: "event", e });
  }
  return items;
}

function summaryOf(section: Section, view: CaseView): string {
  const count = (type: RecordedEvent["type"]) => section.events.filter((e) => e.type === type).length;
  const plural = (n: number, one: string, many: string) => n + " " + (n === 1 ? one : many);
  switch (section.key) {
    case "apertura":
      if (Object.keys(view.responses).length) return "Chequeo rápido";
      return view.dismissal ? "Caso descartado" : plural(view.claims.length, "afirmación a examinar", "afirmaciones a examinar");
    case "respuestas":
      return plural(count("quick_response"), "respuesta", "respuestas") + " con búsqueda propia";
    case "instruccion": {
      const analysts = new Set(section.events.flatMap((e) => (e.type === "evidence_filed" ? [e.evidence.by] : [])));
      return "Pruebas a favor y en contra · " + plural(count("evidence_filed"), "prueba", "pruebas") + " de " + plural(analysts.size, "analista", "analistas");
    }
    case "recopilacion": {
      const last = section.events.findLast((e) => e.type === "source_batch_completed");
      const start = section.events.find((e) => e.type === "source_collection_started");
      return "Enlaces consultados · " + (last?.completed ?? 0) + " de " + (start?.total ?? last?.total ?? 0);
    }
    case "fuentes": {
      const sources = [...view.sources.values()];
      return "Expediente común · " + plural(sources.length, "fuente", "fuentes") + " · " + plural(sources.filter((s) => s.excluded).length, "anulada", "anuladas");
    }
    case "resultado":
      if (Object.keys(view.responses).length) return plural(count("content_vote"), "voto", "votos") + " sobre el contenido completo";
      return plural(count("judgment"), "resultado", "resultados");
    default: {
      const parts = [plural(count("statement"), "intervención", "intervenciones")];
      if (count("objection")) parts.push(plural(count("objection"), "objeción", "objeciones"));
      if (count("vote")) parts.push(plural(count("vote"), "voto", "votos"));
      return parts.join(" · ");
    }
  }
}

function groupTitle(group: Group, ctx: Context): React.ReactNode {
  const statement = group.events.find((e) => e.type === "statement");
  const response = group.events.find((e) => e.type === "quick_response");
  if (response) {
    const cited = response.sources.length;
    return (
      <>
        <span className="font-semibold">{MODEL_NAME[group.by]}</span>
        <span className="text-ink-soft"> · respuesta · {cited} {cited === 1 ? "fuente citada" : "fuentes citadas"}</span>
      </>
    );
  }
  if (!group.stage) {
    const filed = group.events.filter((e) => e.type === "evidence_filed").length;
    return (
      <>
        <span className="font-semibold">{MODEL_NAME[group.by]}</span>
        <span className="text-ink-soft"> · aportes de pruebas · {filed} {filed === 1 ? "prueba" : "pruebas"}</span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">{MODEL_NAME[group.by]}</span>
      <span className="text-ink-soft"> · {STAGE_LABEL[group.stage]}</span>
      {statement && <span className="text-xs"> · <CitationLink id={statement.id} href={"#" + statement.id} /></span>}
      {statement && ctx.view.struck.has(statement.id) && <span className="ml-2 rounded-sm bg-seal px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper">Anulado</span>}
    </>
  );
}

function GroupFold({ group, ctx }: { group: Group; ctx: Context }) {
  const statement = group.events.find((e) => e.type === "statement");
  const response = group.events.find((e) => e.type === "quick_response");
  return (
    <details open className="fold">
      <summary className="fold-summary flex cursor-pointer items-center gap-3">
        <Speaker by={group.by} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{groupTitle(group, ctx)}</span>
          {statement && <span className="fold-preview text-sm text-ink-soft"><Cited text={statement.text} ctx={ctx} /></span>}
          {response && <span className="fold-preview text-sm text-ink-soft">{response.text}</span>}
        </span>
        <Chevron />
      </summary>
      {/* The rail runs from the analyst's mark down to the close of their run. */}
      <div className={"ml-[17px] space-y-3 border-l border-rule pt-2 pl-4 sm:pl-[30px] " + (group.closing ? "pb-3" : "fold-rail-end pb-1")}>
        {group.events.map((e) => <div key={e.seq}><Entry e={e} ctx={ctx} /></div>)}
      </div>
      {group.closing && (
        <div className="flex items-start gap-3">
          <Speaker by={group.by} small />
          <div className="min-w-0 flex-1 pt-0.5"><Entry e={group.closing} ctx={ctx} /></div>
        </div>
      )}
    </details>
  );
}

function SectionFold({ section, index, ctx }: { section: Section; index: number; ctx: Context }) {
  const title = SECTION_TITLE[section.key];
  const items = itemsOf(section);
  return (
    <div data-fold-scope="section" className="relative">
      <details id={"etapa-" + (index + 1)} className="fold scroll-mt-24">
        <summary className="fold-summary flex cursor-pointer items-center gap-3 border-b border-rule pb-2 pr-20">
          <Chevron />
          <span className="min-w-0">
            <h3 className="inline font-display text-2xl">{title}</h3>
            <span className="block text-xs text-ink-soft sm:ml-3 sm:inline">{summaryOf(section, ctx.view)}</span>
          </span>
        </summary>
        <ol className="mt-4 space-y-4">
          {items.map((item) => (
            item.kind === "group" ? (
              <li key={item.seq}><GroupFold group={item} ctx={ctx} /></li>
            ) : (
              <li key={item.e.seq} className={INDENTED.has(item.e.type) ? "ml-4 sm:ml-12" : undefined}><Entry e={item.e} ctx={ctx} /></li>
            )
          ))}
        </ol>
      </details>
      <div className="absolute right-0 top-1">
        <FoldButtons label={title} />
      </div>
    </div>
  );
}

export function Case({ events, view, caseId, sourceAliases = new Map(), models = seatModels({}, events) }: { events: RecordedEvent[]; view: CaseView; caseId: string; sourceAliases?: ReadonlyMap<string, string>; models?: SeatModels }) {
  // La tarjeta ya muestra el resumen, los votos y la decisión proyectados; conservar solo
  // eventos que no estén representados allí (por ejemplo, registros incompletos).
  const visible = events.filter((e) => {
    if (e.type === "case_summary") return false;
    if (e.type === "source_review_vote") {
      const vote = view.sources.get(e.sourceId)?.votes[e.by];
      return !vote || vote.veto !== e.veto || vote.reason !== e.reason;
    }
    if (e.type === "source_decided") return view.sources.get(e.sourceId)?.excluded !== e.excluded;
    return true;
  });
  const sections = sectionsOf(visible);
  const ctx: Context = { view, caseId, refs: citationRefs(events, view), sourceAliases, models };
  return (
    <div data-case data-fold-scope="case">
      <FoldNavigation />
      <div className="mb-6 flex items-center justify-end gap-2 text-xs text-ink-soft">
        <span>Todas las etapas</span>
        <FoldButtons label="todas las etapas" />
      </div>
      <div className="space-y-10">
        {sections.map((section, i) => <SectionFold key={i} section={section} index={i} ctx={ctx} />)}
      </div>
    </div>
  );
}

// Only public, completed contributions belong in the live dialogue. Model steps,
// research logs and reasoning traces are not part of this event allowlist.
function dialogueSpeaker(e: RecordedEvent): Seat | undefined {
  switch (e.type) {
    case "claims_entered":
    case "dismissed":
    case "source_collection_started":
    case "source_batch_started":
    case "source_batch_completed":
    case "evidence_unified":
    case "floor_granted":
    case "ruling":
    case "case_summary":
      return "judge";
    case "judgment":
    case "content_judgment":
      return e.method === "judge" ? "judge" : undefined;
    case "evidence_filed":
      return e.evidence.by;
    case "instruction_completed":
    case "source_review_vote":
    case "statement":
    case "quick_response":
    case "objection":
    case "objection_reply":
    case "vote":
    case "content_vote":
      return e.by;
    default:
      return undefined;
  }
}

export function SessionDialogue({ events, caseId, models = seatModels({}, events), activities = [] }: { events: RecordedEvent[]; caseId: string; models?: SeatModels; activities?: readonly ToolActivity[] }) {
  const view = project(events);
  const ctx: Context = { view, caseId, refs: citationRefs(events, view), sourceAliases: new Map(), models, live: true };
  const messages = events.flatMap((e) => {
    const speaker = dialogueSpeaker(e);
    return speaker ? [{ key: "event:" + e.seq, at: e.at, speaker, model: models[speaker], tool: false, content: <Entry e={e} ctx={ctx} /> }] : [];
  });
  const tools = [...activities].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map((activity) => ({
    key: activity.id, at: activity.at, speaker: activity.seat, tool: true,
    model: activity.modelId ? { id: activity.modelId, effort: activity.effort ?? null } : models[activity.seat],
    content: <ToolActivityEntry activity={activity} caseId={caseId} />,
  }));
  // Merge tool timestamps without changing the authoritative order of court messages.
  const entries: typeof messages = [];
  let next = 0;
  for (const message of messages) {
    while (next < tools.length && tools[next].at <= message.at) entries.push(tools[next++]);
    entries.push(message);
  }
  entries.push(...tools.slice(next));
  return (
    <section aria-labelledby="session-dialogue-title" className="mt-12 text-left">
      <h2 id="session-dialogue-title" className="sr-only">Diálogo del panel</h2>
      <div className="rule-double pt-4">&nbsp;</div>
      <div role="log" aria-labelledby="session-dialogue-title" aria-live="polite" aria-relevant="additions" className="mt-6">
        <ol className="space-y-6">
          {[...entries].reverse().map(({ key, at, speaker, model, tool, content }) => {
            const mark = model ? modelMark(model.id) : speaker === "judge" ? undefined : speaker;
            const name = speaker === "judge" ? "Moderador" + (model ? " · " + modelName(model.id) : "") : model ? modelName(model.id) : MODEL_NAME[speaker];
            return (
              <li key={key} className="flex gap-3">
                <span title={model ? modelDetail(model) : name} className="grid size-9 shrink-0 place-items-center rounded-full border border-rule bg-paper">
                  {mark ? <ModelMark model={mark} className="size-5" /> : <GavelIcon className="size-5 text-seal" />}
                </span>
                <div className="min-w-0 flex-1 border-l border-rule pb-2 pl-4">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-ink-soft">
                    <span className="font-semibold text-ink">{name}{tool && model?.id.includes("/") && <span className="font-normal text-ink-soft"> · {model.id.split("/")[0]}</span>}</span>
                    <time dateTime={at}>{time(at)}</time>
                  </div>
                  {content}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
