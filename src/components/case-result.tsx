import { ANSWER_LABEL, answerLabel, answersOutcome, caseKindLabel, caseOutcome, contentOutcome, VERDICT_LABEL } from "@/domain/case.ts";
import { checkType, COUNSEL, MODEL_NAME, seatModels, type AnswerJudgment, type AnswerSynthesis, type AnswerVotes, type CaseRecord, type CaseView, type ClaimView, type RecordedEvent, type SeatModels } from "@/domain/court.ts";
import { caseDate, formatCaseDate } from "@/domain/case-date.ts";
import { Cited, citationRefs, type Citations } from "./citations.tsx";
import { ClaimsIcon, GavelIcon, JudgeSeal, MegaphoneIcon, VERDICT_TEXT, VerdictDot, VoteChip } from "./marks.tsx";
import { CasePanel } from "./case-panel.tsx";
import { VoteRationaleNavigation } from "./vote-rationale-navigation.tsx";
import type { CaseCosts } from "../domain/cost.ts";

export const voteId = (claimId: string, counsel: string) => "voto-" + claimId + "-" + counsel;
export const reasonsId = (claimId: string) => "fundamentos-" + claimId;

// The mark after each quoted claim: its conclusion, linked to the claim with its reasons expanded.
// Hovering or focusing it shows each analyst's vote, linked to that analyst's own reason.
function ClaimMark({ claim, models }: { claim: ClaimView; models: SeatModels }) {
  const j = claim.judgment;
  const voted = COUNSEL.some((c) => claim.votes[c]);
  const label = "Afirmación " + claim.id + (j ? ": " + VERDICT_LABEL[j.verdict] + (j.method === "judge" ? " (desempate del moderador)" : "") : "") + ". Ver fundamentos";
  return (
    <span className="group/claim relative ml-1.5 inline-block align-middle">
      <a
        href={"#" + reasonsId(claim.id)}
        title={label}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper py-0.5 pr-2 pl-0.5 font-mono text-[11px] leading-none font-medium text-ink-soft no-underline shadow-sm transition hover:border-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep"
      >
        {j ? <VerdictDot verdict={j.verdict} /> : <span className="size-4" aria-hidden />}
        {j?.method === "judge" && <GavelIcon className="size-3 text-seal" />}
        {claim.id}
      </a>
      {voted && (
        <span className="invisible absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition group-focus-within/claim:visible group-focus-within/claim:opacity-100 group-hover/claim:visible group-hover/claim:opacity-100">
          <span role="group" aria-label={"Votos de los analistas sobre " + claim.id} className="flex gap-1.5 whitespace-nowrap rounded-sm border border-rule bg-paper p-1.5 shadow-md">
            {COUNSEL.map((c) => claim.votes[c] ? (
              <a key={c} href={"#" + voteId(claim.id, c)} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + VERDICT_LABEL[claim.votes[c].verdict]} className="rounded-full transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep">
                <VoteChip model={c} verdict={claim.votes[c].verdict} used={models[c]} size="sm" />
              </a>
            ) : <VoteChip key={c} model={c} used={models[c]} size="sm" />)}
          </span>
        </span>
      )}
    </span>
  );
}

const bare = (s: string) => s.trim().replace(/[\s.!?…"'«»“”]+$/u, "").replace(/^[\s"'«»“”]+/u, "");

function Highlighted({ text, claims, models }: { text: string; claims: ClaimView[]; models: SeatModels }) {
  // A claim that quotes the whole content only gets its mark: underlining everything adds nothing.
  const whole = claims.length === 1 && claims[0]!.quote && bare(claims[0]!.quote) === bare(text);
  const marks = claims
    .map((c) => ({ claim: c, start: c.quote ? text.indexOf(c.quote) : -1, length: c.quote.length }))
    .filter((m) => m.start >= 0 && m.length > 0)
    .sort((a, b) => a.start - b.start)
    .filter((m, i, all) => i === 0 || m.start >= all[i - 1].start + all[i - 1].length);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const { claim, start, length } of marks) {
    parts.push(text.slice(at, start));
    parts.push(
      <span key={claim.id}>
        {whole ? text.slice(start, start + length) : <mark className="cita" data-verdict={claim.judgment?.verdict}>{text.slice(start, start + length)}</mark>}
        <ClaimMark claim={claim} models={models} />
      </span>
    );
    at = start + length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Original({ c, view, models, citations, combined = false }: { c: CaseRecord; view: CaseView; models: SeatModels; citations: Citations; combined?: boolean }) {
  const s = c.submission;
  const claims = view.claims;
  const outcome = contentOutcome(view);
  const quick = checkType(s) === "quick";
  // Questions show their answers in the synthesis section, not here.
  const questions = view.contentKind === "question";
  return (
    <figure className={combined ? "min-w-0" : "min-w-0 rounded-sm border border-rule bg-paper/60 p-5"}>
      <figcaption className="mb-5 flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-rule text-celeste-deep"><MegaphoneIcon className="size-5" /></span>
        <span className="font-display text-2xl">{caseKindLabel(view)}</span>
        {outcome ? (
          <span className={"ml-auto inline-flex items-center gap-1.5 text-right font-display text-xl " + VERDICT_TEXT[outcome.verdict]} aria-label={"Resultado del contenido completo: " + VERDICT_LABEL[outcome.verdict]}>
            <VerdictDot verdict={outcome.verdict} /> {VERDICT_LABEL[outcome.verdict]}
          </span>
        ) : combined && <span className="ml-auto font-mono text-[11px] text-ink-soft">{claims[0]?.id}</span>}
      </figcaption>
      {s.kind === "text" && (
        <blockquote className="pl-3 break-words whitespace-pre-line font-display text-2xl leading-snug">
          {/* Hanging guillemet: the text keeps its left edge. */}
          <span aria-hidden className="-ml-[0.6em] inline-block w-[0.6em] text-celeste select-none">«</span>
          {combined ? s.text : <Highlighted text={s.text} claims={claims} models={models} />}
        </blockquote>
      )}
      {s.kind === "link" && (
        <a href={s.url} target="_blank" rel="noreferrer noopener" className="break-all font-display text-xl text-celeste-deep underline decoration-celeste/40 underline-offset-4">
          {s.url}
        </a>
      )}
      {s.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={"/c/" + c.id + "/image"} alt="Imagen enviada" className="max-h-72 max-w-full rounded-sm border border-rule object-contain" />
      )}
      {s.kind !== "text" && s.note && <p className="mt-3 text-sm text-ink-soft">Comentario: {s.note}</p>}
      <p className="mt-3 text-sm text-ink-soft"> - <time dateTime={caseDate(c.createdAt)}>{formatCaseDate(caseDate(c.createdAt), s.resolvedLanguage ?? (s.language && s.language !== "auto" ? s.language : "es"))}</time></p>
      {outcome?.method === "reported" && <p className="mt-3 text-xs text-ink-soft">Consenso informado en el <a href="#case-summary-title" className="text-celeste-deep underline">resumen del moderador</a>.</p>}
      {Object.keys(view.contentVotes).length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="w-fit cursor-pointer text-xs text-celeste-deep hover:underline">{quick ? "Fundamentos de cada voto" : "Evaluaciones del contenido completo"}</summary>
          <ul className="mt-3 space-y-3 rounded-sm bg-paper-deep/50 p-4">
            {COUNSEL.map((by) => {
              const vote = view.contentVotes[by];
              return <li key={by} id={quick ? voteId("contenido", by) : undefined} tabIndex={quick ? -1 : undefined} className={quick ? "scroll-mt-24 target:rounded-sm target:bg-celeste/15" : undefined}><span className="font-semibold">{MODEL_NAME[by]}:</span>{" "}{vote ? <><span className={vote.verdict ? "font-semibold " + VERDICT_TEXT[vote.verdict] : "font-semibold"}>{vote.verdict ? VERDICT_LABEL[vote.verdict] : "No corresponde"}.</span>{" "}<span className="text-ink-soft"><Cited text={vote.rationale} ctx={citations} /></span></> : <span className="text-ink-soft">no votó.</span>}</li>;
            })}
            {view.contentJudgment?.method === "judge" && <li className="border-l-2 border-seal pl-3"><span className="font-semibold text-seal">Desempate del moderador:</span> <Cited text={view.contentJudgment.reasoning} ctx={citations} /></li>}
          </ul>
        </details>
      )}
      {quick && !questions && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3" role="group" aria-label="Votos de los analistas sobre el contenido">
          {COUNSEL.map((by) => {
            const vote = view.contentVotes[by];
            return vote ? (
              <a key={by} href={"#" + voteId("contenido", by)} aria-label={"Ver fundamento de " + MODEL_NAME[by] + ": " + (vote.verdict ? VERDICT_LABEL[vote.verdict] : "No corresponde")} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">
                <VoteChip model={by} verdict={vote.verdict} used={models[by]} />
              </a>
            ) : <VoteChip key={by} model={by} used={models[by]} />;
          })}
        </div>
      )}
    </figure>
  );
}

function ClaimCard({ claim, models, citations, children }: { claim: ClaimView; models: SeatModels; citations: Citations; children?: React.ReactNode }) {
  const j = claim.judgment;
  const agreeing = j ? COUNSEL.filter((c) => claim.votes[c]?.verdict === j.verdict).length : 0;
  return (
    <article id={claim.id} data-claim aria-label={"Afirmación " + claim.id} className={"reveal grid scroll-mt-24 gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto] " + (children ? "min-w-0 rounded-sm border border-rule bg-paper/60 p-5" : "border-t border-rule py-5 lg:grid-cols-[minmax(0,1fr)_12rem_auto]")}>
      {children ? <div className="min-w-0 sm:col-span-2">{children}</div> : (
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <p className="font-mono text-[11px] text-ink-soft">{claim.id}</p>
          <h3 className="mt-1 break-words font-display text-xl leading-snug"><Cited text={claim.text} ctx={citations} /></h3>
        </div>
      )}
      <div className="flex items-center gap-3">
        {j ? (
          <>
            {j.method === "judge" ? <JudgeSeal verdict={j.verdict} judge={models.judge} /> : <VerdictDot verdict={j.verdict} className="size-6" />}
            <div>
              <p className={"font-display text-2xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
              <p className={"mt-1 text-[10px] " + (j.method === "judge" ? "text-seal" : "text-ink-soft")}>{j.method === "judge" ? "Desempate del moderador" : "Mayoría · " + agreeing + " de " + COUNSEL.length}</p>
            </div>
          </>
        ) : <p className="text-sm text-ink-soft">Sin resultado registrado</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end lg:self-center" role="group" aria-label={"Votos de los analistas sobre " + claim.id}>
        {COUNSEL.map((c) => claim.votes[c] ? (
          <a key={c} href={"#" + voteId(claim.id, c)} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + VERDICT_LABEL[claim.votes[c].verdict]} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">
            <VoteChip model={c} verdict={claim.votes[c].verdict} used={models[c]} />
          </a>
        ) : <VoteChip key={c} model={c} used={models[c]} />)}
      </div>
      <details id={reasonsId(claim.id)} className={"text-sm sm:col-span-2 " + (children ? "" : "lg:col-span-3")}>
        <summary className="w-fit cursor-pointer select-none text-xs text-celeste-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">Fundamentos de cada voto<span className="sr-only"> sobre {claim.id}</span></summary>
        <ul className="mt-3 space-y-3 rounded-sm bg-paper-deep/50 p-4">
          {COUNSEL.map((c) => (
            <li key={c} id={voteId(claim.id, c)} tabIndex={-1} className="scroll-mt-24 target:rounded-sm target:bg-celeste/15">
              <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
              {claim.votes[c] ? (
                <>
                  <span className={"font-semibold " + VERDICT_TEXT[claim.votes[c].verdict]}>{VERDICT_LABEL[claim.votes[c].verdict]}.</span>{" "}
                  <span className="text-ink-soft"><Cited text={claim.votes[c].rationale} ctx={citations} /></span>
                </>
              ) : <span className="text-ink-soft">no votó.</span>}
            </li>
          ))}
          {j?.method === "judge" && (
            <li className="border-l-2 border-seal pl-3">
              <span className="font-semibold text-seal">Moderador:</span> <span className="text-ink-soft"><Cited text={j.reasoning} ctx={citations} /></span>
            </li>
          )}
        </ul>
      </details>
    </article>
  );
}

// The panel's answer to one question (to the whole material without one): Sí,
// No, Depende, No sé or Dato, each analyst's, and their reasons. Questions recorded
// before the answers were rated have none.
function Answer({ id, votes, judgment, models, citations }: { id: string; votes: AnswerVotes; judgment?: AnswerJudgment; models: SeatModels; citations: Citations }) {
  if (!judgment && !COUNSEL.some((c) => votes[c])) return null;
  const agreeing = judgment ? COUNSEL.filter((c) => votes[c]?.verdict === judgment.verdict).length : 0;
  return (
    <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex items-center gap-3">
        {judgment ? (
          <>
            {judgment.method === "judge" ? <JudgeSeal verdict={judgment.verdict} judge={models.judge} question /> : <VerdictDot verdict={judgment.verdict} className="size-6" />}
            <div>
              <p className={"font-display text-2xl leading-none " + VERDICT_TEXT[judgment.verdict]}>{answerLabel(judgment.verdict)}</p>
              <p className={"mt-1 text-[10px] " + (judgment.method === "judge" ? "text-seal" : "text-ink-soft")}>
                {judgment.method === "judge" ? "Desempate del moderador" : "Mayoría · " + agreeing + " de " + COUNSEL.length}
              </p>
            </div>
          </>
        ) : <p className="text-sm text-ink-soft">Sin respuesta del panel</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end" role="group" aria-label={"Respuestas de los analistas" + (id === WHOLE ? "" : " a " + id)}>
        {COUNSEL.map((c) => votes[c] ? (
          <a key={c} href={"#" + voteId(id, c)} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + answerLabel(votes[c].verdict)} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">
            <VoteChip model={c} verdict={votes[c].verdict} used={models[c]} question />
          </a>
        ) : <VoteChip key={c} model={c} used={models[c]} question />)}
      </div>
      <details id={reasonsId(id)} className="text-sm sm:col-span-2">
        <summary className="w-fit cursor-pointer select-none text-xs text-celeste-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">Fundamentos de cada respuesta{id !== WHOLE && <span className="sr-only"> a {id}</span>}</summary>
        <ul className="mt-3 space-y-3 rounded-sm bg-paper-deep/50 p-4">
          {COUNSEL.map((c) => (
            <li key={c} id={voteId(id, c)} tabIndex={-1} className="scroll-mt-24 target:rounded-sm target:bg-celeste/15">
              <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
              {votes[c] ? (
                <>
                  <span className={"font-semibold " + VERDICT_TEXT[votes[c].verdict]}>{answerLabel(votes[c].verdict)}.</span>{" "}
                  <span className="text-ink-soft"><Cited text={votes[c].rationale} ctx={citations} /></span>
                </>
              ) : <span className="text-ink-soft">no respondió.</span>}
            </li>
          ))}
          {judgment?.method === "judge" && (
            <li className="border-l-2 border-seal pl-3">
              <span className="font-semibold text-seal">Moderador:</span> <span className="text-ink-soft"><Cited text={judgment.reasoning} ctx={citations} /></span>
            </li>
          )}
        </ul>
      </details>
    </div>
  );
}

// The anchor of the answer to the whole material, when no question was identified.
const WHOLE = "respuesta";

// The moderator's synthesis of the answers to one question: whether it gives
// the majority's opinion or each position.
function Synthesis({ synthesis, citations }: { synthesis?: AnswerSynthesis; citations: Citations }) {
  if (!synthesis) return <p className="mt-3 text-sm text-ink-soft">No hay síntesis del moderador registrada.</p>;
  return (
    <>
      <p className="mt-2 text-xs font-medium text-ink-soft">{synthesis.majority ? "Opinión mayoritaria de los analistas" : "Sin mayoría: posiciones de los analistas"}</p>
      <p className="mt-2 whitespace-pre-line leading-relaxed"><Cited text={synthesis.text} ctx={citations} /></p>
    </>
  );
}

export function CaseResult({ c, view, events = [], models = seatModels(c, events), costs }: { c: CaseRecord; view: CaseView; events?: readonly RecordedEvent[]; models?: SeatModels; costs?: CaseCosts }) {
  const citations: Citations = { caseId: c.id, refs: citationRefs(events, view) };
  const outcome = caseOutcome(view);
  const content = contentOutcome(view);
  const quick = checkType(c.submission) === "quick";
  const tieBreaks = quick ? [
    ...view.claims.flatMap((claim) => claim.judgment?.method === "judge" && claim.judgment.reasoning.trim()
      ? [{ label: "Afirmación " + claim.id, text: claim.judgment.reasoning }] : []),
    ...(view.contentJudgment?.method === "judge" && view.contentJudgment.reasoning.trim()
      ? [{ label: view.claims.length ? "Contenido completo" : "", text: view.contentJudgment.reasoning }] : []),
  ] : [];
  const questions = view.contentKind === "question";
  const answers = questions ? answersOutcome(view) : undefined;
  const rated = questions && (view.questions.some((q) => q.judgment || COUNSEL.some((c) => q.votes[c])) || view.answerJudgment !== undefined || COUNSEL.some((c) => view.answerVotes[c]));
  const combinedClaim = !view.dismissal && c.submission.kind === "text" && view.claims.length === 1 && bare(c.submission.text) === bare(view.claims[0]!.text) ? view.claims[0] : undefined;
  return (
    <>
      <VoteRationaleNavigation />
      <div data-case-overview className="mt-6 space-y-4">
        <div className="grid items-start gap-4 lg:has-[section]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          {combinedClaim ? (
            <ClaimCard claim={combinedClaim} models={models} citations={citations}>
              <Original c={c} view={view} models={models} citations={citations} combined />
            </ClaimCard>
          ) : <Original c={c} view={view} models={models} citations={citations} />}
          <CasePanel c={c} models={models} costs={costs} label={caseKindLabel(view)} />
        </div>
        {view.dismissal ? (
          <p className="flex items-start gap-3 rounded-sm border border-seal/40 bg-seal/5 p-5">
            <GavelIcon className="mt-1 size-5 shrink-0 text-seal" />
            <span>{view.dismissal}</span>
          </p>
        ) : !combinedClaim && view.claims.length > 0 && (
          <section aria-labelledby="case-claims-title" className="rounded-sm border border-rule bg-paper/60 px-5 pt-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-rule text-celeste-deep"><ClaimsIcon className="size-5" /></span>
              <div>
                <h2 id="case-claims-title" className="font-display text-2xl">Afirmaciones</h2>
                <p className="font-mono text-[10px] text-ink-soft">{view.claims.length} {view.claims.length === 1 ? "examinada" : "examinadas"}</p>
              </div>
              {outcome && (
                <div className="ml-auto text-right" aria-label={(content ? "Resultado de afirmaciones: " : "Resultado general: ") + (outcome === "mixto" ? "Mixto" : VERDICT_LABEL[outcome])}>
                  <p className="text-[10px] text-ink-soft">{content ? "Resultado de afirmaciones" : "Resultado general"}</p>
                  <p className={"mt-0.5 inline-flex items-center gap-1.5 font-display text-xl leading-none " + (outcome === "mixto" ? "text-ink" : VERDICT_TEXT[outcome])}>
                    {outcome !== "mixto" && <VerdictDot verdict={outcome} />}
                    {outcome === "mixto" ? "Mixto" : VERDICT_LABEL[outcome]}
                  </p>
                </div>
              )}
            </div>
            {view.claims.map((claim) => <ClaimCard key={claim.id} claim={claim} models={models} citations={citations} />)}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule py-4 text-[11px] text-ink-soft">
              <span>Cada círculo es un voto:</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-verdadero" /> {VERDICT_LABEL.verdadero}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-falso" /> {VERDICT_LABEL.falso}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-insostenible" /> {VERDICT_LABEL.no_verificable}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-enganoso" /> {VERDICT_LABEL.enganoso}</span>
              <a href="/method#resultados" className="text-celeste-deep underline underline-offset-4">Cómo leer los resultados</a>
            </div>
          </section>
        )}
      </div>
      {questions ? (
        <section aria-labelledby="case-summary-title" className="mt-8 rule-double pt-5">
          <div className="flex flex-wrap items-start gap-3">
            <div>
              <h2 id="case-summary-title" className="font-display text-3xl">{rated ? "Respuestas del panel" : "Síntesis del panel"}</h2>
              <p className="mt-1 text-xs text-ink-soft">{rated ? "Cada analista responde Sí, No, Depende, No sé o Dato; tres respuestas iguales dan la del panel, y el moderador sintetiza sus fundamentos." : "Por el moderador · Las preguntas no se califican: el panel responde y el moderador sintetiza sus respuestas."}</p>
            </div>
            {answers && view.questions.length > 1 && (
              <div className="ml-auto text-right" aria-label={"Resultado general: " + (answers === "mixto" ? "Mixto" : ANSWER_LABEL[answers])}>
                <p className="text-[10px] text-ink-soft">Resultado general</p>
                <p className={"mt-0.5 inline-flex items-center gap-1.5 font-display text-xl leading-none " + (answers === "mixto" ? "text-ink" : VERDICT_TEXT[answers])}>
                  {answers !== "mixto" && <VerdictDot verdict={answers} />}
                  {answers === "mixto" ? "Mixto" : ANSWER_LABEL[answers]}
                </p>
              </div>
            )}
          </div>
          {view.questions.map((question) => (
            <article key={question.id} id={question.id} aria-label={"Pregunta " + question.id} className="mt-5 scroll-mt-24 border-t border-rule pt-4 target:rounded-sm target:bg-celeste/10">
              <p className="font-mono text-[11px] text-ink-soft">{question.id}</p>
              <h3 className="mt-1 break-words font-display text-xl leading-snug"><Cited text={question.text} ctx={citations} /></h3>
              <Answer id={question.id} votes={question.votes} judgment={question.judgment} models={models} citations={citations} />
              <Synthesis synthesis={question.synthesis} citations={citations} />
            </article>
          ))}
          {!view.questions.length && <Answer id={WHOLE} votes={view.answerVotes} judgment={view.answerJudgment} models={models} citations={citations} />}
          {(view.synthesis || !view.questions.length) && <Synthesis synthesis={view.synthesis} citations={citations} />}
          {rated && (
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-4 text-[11px] text-ink-soft">
              <span>Cada círculo es una respuesta:</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-verdadero" /> {ANSWER_LABEL.verdadero}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-falso" /> {ANSWER_LABEL.falso}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-enganoso" /> {ANSWER_LABEL.enganoso}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-insostenible" /> {ANSWER_LABEL.no_verificable}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-dato" /> {ANSWER_LABEL.dato}</span>
              <a href="/method#respuestas" className="text-celeste-deep underline underline-offset-4">Cómo leer las respuestas</a>
            </div>
          )}
        </section>
      ) : !view.dismissal && (view.summary || tieBreaks.length > 0 || (quick && c.status === "resolved")) && (
        <section aria-labelledby="case-summary-title" className="mt-8 rule-double pt-5">
          <h2 id="case-summary-title" className="font-display text-3xl">Resumen del caso</h2>
          {(view.summary || tieBreaks.length > 0) && <p className="mt-1 text-xs text-ink-soft">Por el moderador</p>}
          {view.summary && <p className="mt-3 whitespace-pre-line leading-relaxed"><Cited text={view.summary} ctx={citations} /></p>}
          {tieBreaks.map(({ label, text }) => <p key={label || "contenido"} className="mt-3 whitespace-pre-line leading-relaxed">{label && <><span className="font-semibold">{label}:</span>{" "}</>}<Cited text={text} ctx={citations} /></p>)}
          {!view.summary && tieBreaks.length === 0 && <p className="mt-3 text-sm text-ink-soft">No hay resumen del moderador registrado para este caso.</p>}
        </section>
      )}
    </>
  );
}